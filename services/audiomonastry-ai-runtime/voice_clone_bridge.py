#!/usr/bin/env python3
"""Voice-Clone-Bridge: fish-speech 1.5 (Zero-Shot-TTS mit Stimmreferenz).

Diese Datei laeuft NICHT in unserem Haupt-Environment, sondern im venv
`/opt/voiceclone-venv` (siehe `Dockerfile.voicedeps`) - fish-speech verlangt
`torch<=2.4.1` und `numpy<=1.26.4`, unser Runtime-Image faehrt torch 2.6.0 und
numpy 2.2.2. Der Handler ruft die Bridge als Subprozess auf und liest genau EINE
JSON-Zeile von stdout.

Vertrag
-------
Eingabe (`--request-json <pfad>` oder stdin)::

    {"modelDir": "/pfad/zum/hf-snapshot",         # fishaudio/fish-speech-1.5
     "text": "Zu sprechender Text",
     "referenceAudioPath": "/tmp/ref.wav",         # optional: Stimme klonen
     "referenceText": "Was im Referenzaudio gesagt wird",  # optional, verbessert die Qualitaet
     "decoderConfigName": "firefly-gan-vq-fsq-8x1024-21hz-generator",
     "maxNewTokens": 1024, "chunkLength": 200,
     "temperature": 0.7, "topP": 0.7, "repetitionPenalty": 1.2,
     "seed": 0,
     "outputPath": "/tmp/out.wav"}

Ausgabe (eine Zeile stdout)::

    {"ok": true, "outputPath": "...", "sampleRate": 44100, "seconds": 3.21}
    {"ok": false, "code": "MODEL_UNAVAILABLE", "error": "..."}

Exitcodes: 0 ok | 12 Abhaengigkeit/venv fehlt | 13 ungueltige Anfrage |
14 Inferenz fehlgeschlagen.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, NoReturn, Tuple

VENV_HINT = (
    "venv /opt/voiceclone-venv fehlt oder ist unvollstaendig - fish-speech laeuft "
    "NICHT im Haupt-Environment (torch/numpy-Konflikt, siehe Dockerfile.voicedeps). "
    "Bridge mit /opt/voiceclone-venv/bin/python aufrufen."
)


def _fail(code: str, message: str, exit_code: int) -> NoReturn:
    print(json.dumps({"ok": False, "code": code, "error": message}, ensure_ascii=False))
    raise SystemExit(exit_code)


def _load_fish_speech() -> Dict[str, Any]:
    """Importiert fish-speech erst hier - so bleibt die Fehlermeldung klar."""
    try:
        import torch  # noqa: F401  (Importpruefung)
        from fish_speech.inference_engine import TTSInferenceEngine
        from fish_speech.models.text2semantic.inference import launch_thread_safe_queue
        from fish_speech.models.vqgan.inference import load_model as load_decoder_model
        from fish_speech.utils.schema import ServeReferenceAudio, ServeTTSRequest
    except Exception as exc:  # noqa: BLE001 - jede Importpanne ist eine fehlende Abhaengigkeit
        _fail("MODEL_UNAVAILABLE", f"{VENV_HINT} Ursache: {type(exc).__name__}: {exc}", 12)
    return {
        "torch": torch,
        "TTSInferenceEngine": TTSInferenceEngine,
        "launch_thread_safe_queue": launch_thread_safe_queue,
        "load_decoder_model": load_decoder_model,
        "ServeTTSRequest": ServeTTSRequest,
        "ServeReferenceAudio": ServeReferenceAudio,
    }


def _read_request(argv: list[str]) -> Dict[str, Any]:
    parser = argparse.ArgumentParser(description="fish-speech-Bridge (venv)")
    parser.add_argument("--selftest", action="store_true", help="nur Importe pruefen")
    parser.add_argument("--request-json", help="Pfad zur Anfrage (sonst stdin)")
    args = parser.parse_args(argv)

    if args.selftest:
        _load_fish_speech()
        print("selftest ok: fish-speech-Importe im venv verfuegbar")
        raise SystemExit(0)

    raw = ""
    if args.request_json:
        with open(args.request_json, "r", encoding="utf-8") as handle:
            raw = handle.read()
    else:
        raw = sys.stdin.read()
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        _fail("BAD_REQUEST", f"Anfrage ist kein JSON: {exc}", 13)
    if not isinstance(data, dict):
        _fail("BAD_REQUEST", "Anfrage muss ein JSON-Objekt sein", 13)
    return data


def _audio_bytes(path: str) -> bytes:
    if not path or not os.path.isfile(path):
        _fail("BAD_REQUEST", f"Referenzaudio nicht gefunden: {path!r}", 13)
    with open(path, "rb") as handle:
        data = handle.read()
    if not data:
        _fail("BAD_REQUEST", f"Referenzaudio ist leer: {path!r}", 13)
    return data


def _split_chunk(chunk: Any) -> Tuple[Any, int]:
    """Trennt einen Inferenz-Chunk in (Audio, Samplerate).

    Die Reihenfolge ist in fish-speech nicht ueber Versionen stabil: mal
    `(audio, sample_rate)`, mal `(sample_rate, audio)`. Statt zu raten wird der
    ganzzahlige Teil als Samplerate erkannt; alles andere gilt als Audio.
    """
    if isinstance(chunk, tuple) and len(chunk) == 2:
        left, right = chunk
        if isinstance(left, int) and not isinstance(right, int):
            return right, int(left)
        if isinstance(right, int) and not isinstance(left, int):
            return left, int(right)
        return left, int(right) if isinstance(right, int) else 44100
    return chunk, 44100


def run(request: Dict[str, Any]) -> Dict[str, Any]:
    modules = _load_fish_speech()
    torch = modules["torch"]

    model_dir = str(request.get("modelDir") or "")
    text = str(request.get("text") or "").strip()
    output_path = str(request.get("outputPath") or "")
    if not model_dir or not os.path.isdir(model_dir):
        _fail("BAD_REQUEST", f"modelDir fehlt oder existiert nicht: {model_dir!r}", 13)
    if not text:
        _fail("BAD_REQUEST", "text fehlt (leerer Auftrag)", 13)
    if not output_path:
        _fail("BAD_REQUEST", "outputPath fehlt", 13)

    seed = int(request.get("seed") or 0)
    if seed:
        torch.manual_seed(seed)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    precision = torch.bfloat16
    decoder_config = str(request.get("decoderConfigName") or "firefly-gan-vq-fsq-8x1024-21hz-generator")
    llama_checkpoint = os.path.join(model_dir, "model.pth")
    decoder_checkpoint = os.path.join(model_dir, f"{decoder_config}.pth")
    for path in (llama_checkpoint, decoder_checkpoint):
        if not os.path.isfile(path):
            _fail("BAD_REQUEST", f"Modell-Datei fehlt im Snapshot: {path!r}", 13)

    llama_queue = modules["launch_thread_safe_queue"](
        checkpoint_path=llama_checkpoint, device=device, precision=precision, compile=False
    )
    decoder_model = modules["load_decoder_model"](
        config_name=decoder_config, checkpoint_path=decoder_checkpoint, device=device
    )
    engine = modules["TTSInferenceEngine"](
        llama_queue=llama_queue, decoder_model=decoder_model, precision=precision, compile=False
    )

    references = []
    reference_audio = str(request.get("referenceAudioPath") or "")
    if reference_audio:
        references.append(
            modules["ServeReferenceAudio"](
                audio=_audio_bytes(reference_audio),
                text=str(request.get("referenceText") or ""),
            )
        )

    tts_request = modules["ServeTTSRequest"](
        text=text,
        references=references,
        reference_id=None,
        max_new_tokens=int(request.get("maxNewTokens") or 1024),
        chunk_length=int(request.get("chunkLength") or 200),
        top_p=float(request.get("topP") or 0.7),
        repetition_penalty=float(request.get("repetitionPenalty") or 1.2),
        temperature=float(request.get("temperature") or 0.7),
        format="wav",
        streaming=False,
        use_memory_cache="off",
    )

    soundfile = None
    numpy = None
    try:
        import numpy  # noqa: F401
        import soundfile  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        _fail("MODEL_UNAVAILABLE", f"numpy/soundfile fehlen: {type(exc).__name__}: {exc}", 12)

    # Die Engine liefert Chunks; wir sammeln alle und schreiben EINE Datei.
    rendered = []
    sample_rate = 44100
    iterator = engine.inference(tts_request)  # type: ignore[attr-defined]
    for chunk in iterator:
        audio, sample_rate = _split_chunk(chunk)
        if audio is None:
            continue
        rendered.append(numpy.asarray(audio))
    if not rendered:
        _fail("INFERENCE_FAILED", "fish-speech lieferte kein Audio", 14)

    waveform = numpy.concatenate([numpy.ravel(item) for item in rendered]) if len(rendered) > 1 else numpy.ravel(rendered[0])
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    soundfile.write(output_path, waveform, int(sample_rate))
    seconds = float(len(waveform)) / float(sample_rate or 1)
    return {
        "ok": True,
        "outputPath": output_path,
        "sampleRate": int(sample_rate),
        "seconds": round(seconds, 3),
    }


def main(argv: list[str] | None = None) -> int:
    request = _read_request(list(sys.argv[1:] if argv is None else argv))
    try:
        result = run(request)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - jede Inferenzpanne wird ehrlich gemeldet
        _fail("INFERENCE_FAILED", f"fish-speech-Inferenz fehlgeschlagen: {type(exc).__name__}: {exc}", 14)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
