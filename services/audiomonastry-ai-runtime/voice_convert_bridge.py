#!/usr/bin/env python3
"""Voice-Convert-Bridge: OpenVoice V2 (Tone-Color-Conversion, MIT).

Ersetzt das Timbre einer bestehenden Aufnahme durch eine Zielstimme - genau die
Faehigkeit, fuer die RVC vorgesehen war. RVC selbst ist auf diesem Stack nicht
installierbar (gemessen 2026-09-16: `rvc-python` verlangt `omegaconf==2.0.6`, das
mit pip >= 24.1 wegen ungueltiger Metadaten nicht aufloest, plus
`numpy<=1.23.5`/`fairseq==0.12.2`); OpenVoice V2 liefert dieselbe Funktion unter
MIT und laeuft im isolierten venv `/opt/voiceclone-venv`.

Vertrag
-------
Eingabe (`--request-json <pfad>` oder stdin)::

    {"modelDir": "/pfad/zu/myshell-ai--OpenVoiceV2",
     "sourceAudioPath": "/tmp/source.wav",      # Aufnahme, deren Stimme ersetzt wird
     "targetReferencePath": "/tmp/target.wav",  # Zielstimme (wird geklont)
     "sourceSePath": "<modelDir>/base_speakers/ses/en-default.pth",  # optional
     "tau": 0.3,
     "outputPath": "/tmp/converted.wav"}

Ausgabe (eine Zeile stdout)::

    {"ok": true, "outputPath": "...", "sampleRate": 22050, "seconds": 4.1}
    {"ok": false, "code": "MODEL_UNAVAILABLE", "error": "..."}

Exitcodes: 0 ok | 12 Abhaengigkeit/venv fehlt | 13 ungueltige Anfrage |
14 Konvertierung fehlgeschlagen.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, NoReturn

VENV_HINT = (
    "venv /opt/voiceclone-venv fehlt oder ist unvollstaendig - OpenVoice laeuft "
    "NICHT im Haupt-Environment (numpy/torch-Konflikt, siehe Dockerfile.voicedeps). "
    "Bridge mit /opt/voiceclone-venv/bin/python aufrufen."
)


def _fail(code: str, message: str, exit_code: int) -> NoReturn:
    print(json.dumps({"ok": False, "code": code, "error": message}, ensure_ascii=False))
    raise SystemExit(exit_code)


def _load_openvoice() -> Dict[str, Any]:
    try:
        import numpy  # noqa: F401
        import soundfile  # noqa: F401
        import torch
        from openvoice import se_extractor
        from openvoice.api import ToneColorConverter
    except Exception as exc:  # noqa: BLE001 - jede Importpanne ist eine fehlende Abhaengigkeit
        _fail("MODEL_UNAVAILABLE", f"{VENV_HINT} Ursache: {type(exc).__name__}: {exc}", 12)
    return {
        "numpy": numpy,
        "soundfile": soundfile,
        "torch": torch,
        "se_extractor": se_extractor,
        "ToneColorConverter": ToneColorConverter,
    }


def _read_request(argv: list[str]) -> Dict[str, Any]:
    parser = argparse.ArgumentParser(description="OpenVoice-Bridge (venv)")
    parser.add_argument("--selftest", action="store_true", help="nur Importe pruefen")
    parser.add_argument("--request-json", help="Pfad zur Anfrage (sonst stdin)")
    args = parser.parse_args(argv)

    if args.selftest:
        _load_openvoice()
        print("selftest ok: OpenVoice-Importe im venv verfuegbar")
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


def _require_file(path: str, field: str) -> str:
    if not path or not os.path.isfile(path):
        _fail("BAD_REQUEST", f"{field} fehlt oder existiert nicht: {path!r}", 13)
    return path


def _load_embedding(torch: Any, path: str, device: str) -> Any:
    """Laedt ein Speaker-Embedding.

    `torch.load` hat ab torch 2.6 `weights_only=True` als Standard; unser venv
    faehrt 2.4.1. Beide Faelle werden bedient, damit die Bridge nicht an einer
    Signaturaenderung scheitert.
    """
    try:
        return torch.load(path, map_location=device)
    except TypeError:
        return torch.load(path, map_location=device, weights_only=False)


def _pick_embedding(result: Any) -> Any:
    """Zieht das Embedding aus dem Rueckgabewert von `get_se`.

    OpenVoice gibt `(name, se)` bzw. `(audio, se)` zurueck; statt die Reihenfolge
    zu raten, wird das Tensor-aehnliche Element gewaehlt.
    """
    items = result if isinstance(result, (tuple, list)) else [result]
    for item in items:
        if hasattr(item, "shape") and hasattr(item, "dim"):
            return item
    return items[-1]


def run(request: Dict[str, Any]) -> Dict[str, Any]:
    modules = _load_openvoice()
    torch = modules["torch"]

    model_dir = str(request.get("modelDir") or "")
    if not model_dir or not os.path.isdir(model_dir):
        _fail("BAD_REQUEST", f"modelDir fehlt oder existiert nicht: {model_dir!r}", 13)
    source_path = _require_file(str(request.get("sourceAudioPath") or ""), "sourceAudioPath")
    target_path = _require_file(str(request.get("targetReferencePath") or ""), "targetReferencePath")
    output_path = str(request.get("outputPath") or "")
    if not output_path:
        _fail("BAD_REQUEST", "outputPath fehlt", 13)

    converter_config = os.path.join(model_dir, "converter", "config.json")
    converter_checkpoint = os.path.join(model_dir, "converter", "checkpoint.pth")
    for path in (converter_config, converter_checkpoint):
        if not os.path.isfile(path):
            _fail("BAD_REQUEST", f"Konverter-Datei fehlt im Snapshot: {path!r}", 13)

    source_se_path = str(
        request.get("sourceSePath") or os.path.join(model_dir, "base_speakers", "ses", "en-default.pth")
    )
    if not os.path.isfile(source_se_path):
        _fail("BAD_REQUEST", f"sourceSePath fehlt: {source_se_path!r}", 13)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    converter = modules["ToneColorConverter"](converter_config, device=device)
    converter.load_ckpt(converter_checkpoint)

    src_se = _load_embedding(torch, source_se_path, device)
    target_se = _pick_embedding(
        # `vad=False`: das Referenzaudio wird als Ganzes genommen. VAD wuerde
        # faster-whisper zur Laufzeit nachladen; fuer Referenzclips von wenigen
        # Sekunden ist das unnoetig und spart Kaltstartzeit.
        modules["se_extractor"].get_se(target_path, converter, vad=False)
    )

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    converter.convert(
        audio_src_path=source_path,
        src_se=src_se,
        tgt_se=target_se,
        output_path=output_path,
        tau=float(request.get("tau") or 0.3),
        message=str(request.get("message") or "@audioMONASTRY"),
    )
    if not os.path.isfile(output_path):
        _fail("CONVERT_FAILED", f"OpenVoice schrieb keine Ausgabe: {output_path!r}", 14)

    info = modules["soundfile"].info(output_path)
    seconds = float(info.frames) / float(info.samplerate or 1)
    return {
        "ok": True,
        "outputPath": output_path,
        "sampleRate": int(info.samplerate),
        "seconds": round(seconds, 3),
    }


def main(argv: list[str] | None = None) -> int:
    request = _read_request(list(sys.argv[1:] if argv is None else argv))
    try:
        result = run(request)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - jede Panne wird ehrlich gemeldet
        _fail("CONVERT_FAILED", f"OpenVoice-Konvertierung fehlgeschlagen: {type(exc).__name__}: {exc}", 14)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
