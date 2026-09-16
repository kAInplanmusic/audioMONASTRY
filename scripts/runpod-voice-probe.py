#!/usr/bin/env python3
"""Live-Probe fuer die Voice-Rollen: `tts` (fish-speech) und `voice.convert` (OpenVoice).

Belegt den echten Pfad gegen den voice-Endpoint und legt das Ergebnis als WAV plus
Messwerte als JSON ab - dieselbe Beweisform wie `runpod-comfyui-probe.py`.

Beispiele::

    # Stimmklon: Referenzaufnahme + Text -> Sprachausgabe in der Referenzstimme
    python3 scripts/runpod-voice-probe.py --task tts --model fish-speech-1.5 \
        --text "Hallo, das ist ein Klon-Test." \
        --reference logs/mos-20260913/mms-tts-deu-01.wav \
        --out logs/probes/fishspeech-clone-20260916.json

    # Stimmonvertierung: Timbre von --source auf die Stimme aus --target ziehen
    python3 scripts/runpod-voice-probe.py --task voice.convert --model openvoice-v2 \
        --source logs/mos-20260913/mms-tts-deu-01.wav \
        --target logs/mos-20260913/mms-tts-deu-02.wav \
        --out logs/probes/openvoice-convert-20260916.json

Umgebung: `RP_API_KEY` (oder `RP_AGENT_KEY`/`RUNPOD_API_KEY`) und
`RP_ENDPOINT_ID_VOICE`; `--endpoint` ueberschreibt die ID.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

API_BASE = os.environ.get("RUNPOD_API_BASE", "https://api.runpod.ai/v2").rstrip("/")
POLL_SECONDS = 3.0


def _api_key() -> str:
    for name in ("RP_AGENT_KEY", "RP_API_KEY", "RUNPOD_API_KEY"):
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    raise SystemExit("FEHLER: RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY fehlt")


def _endpoint_id(explicit: str = "") -> str:
    value = (explicit or os.environ.get("RP_ENDPOINT_ID_VOICE") or "").strip()
    if not value:
        raise SystemExit("FEHLER: RP_ENDPOINT_ID_VOICE fehlt (oder --endpoint setzen)")
    return value


def _read_wav_base64(path: str) -> str:
    data = pathlib.Path(path).read_bytes()
    if len(data) < 44:
        raise SystemExit(f"FEHLER: {path} ist zu klein fuer eine WAV-Datei ({len(data)} Bytes)")
    return base64.b64encode(data).decode()


def build_payload(args: argparse.Namespace) -> Dict[str, Any]:
    """Baut die Anfrage fuer den jeweiligen Task.

    Bewusst getrennt und ohne Netz - so ist der Vertrag testbar.
    """
    if args.task == "tts":
        payload: Dict[str, Any] = {"text": args.text, "model": args.model, "task": args.task}
        if args.reference:
            payload["referenceAudioBase64"] = _read_wav_base64(args.reference)
            if args.reference_text:
                payload["referenceText"] = args.reference_text
        return payload
    if args.task == "voice.convert":
        if not args.source or not args.target:
            raise SystemExit("FEHLER: voice.convert braucht --source und --target")
        return {
            "task": args.task,
            "model": args.model,
            "sourceAudioBase64": _read_wav_base64(args.source),
            "targetReferenceBase64": _read_wav_base64(args.target),
            "tau": args.tau,
        }
    raise SystemExit(f"FEHLER: unbekannter Task {args.task!r}")


def summarize_output(output: Any) -> str:
    """Kurzfassung ohne die (grossen) Audio-Nutzlasten."""
    if not isinstance(output, dict):
        return f"{type(output).__name__}: {str(output)[:200]}"
    parts = []
    for key, value in output.items():
        if isinstance(value, str) and len(value) > 256:
            parts.append(f"{key}=<str {len(value)} Zeichen, beginnt {value[:24]!r}>")
        else:
            parts.append(f"{key}={json.dumps(value, ensure_ascii=False)[:160]}")
    return "; ".join(parts)


def _post(url: str, body: Dict[str, Any], api_key: str) -> Dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - feste API-Basis
        return json.loads(response.read().decode())


def _get(url: str, api_key: str) -> Dict[str, Any]:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
        return json.loads(response.read().decode())


def run(args: argparse.Namespace) -> int:
    api_key = _api_key()
    endpoint = _endpoint_id(args.endpoint)
    payload = build_payload(args)
    body = {"input": payload}

    print(f"[voice-probe] Task={args.task} Modell={args.model} Endpoint={endpoint}")
    started = time.time()
    try:
        job = _post(f"{API_BASE}/{endpoint}/run", body, api_key)
    except urllib.error.HTTPError as exc:
        print(f"[voice-probe] HTTP {exc.code}: {exc.read().decode()[:400]}")
        return 1
    job_id = str(job.get("id", ""))
    if not job_id:
        print(f"[voice-probe] keine Job-ID: {json.dumps(job)[:300]}")
        return 1
    print(f"[voice-probe] Job {job_id} eingereicht")

    deadline = started + args.timeout
    state: Dict[str, Any] = {}
    while time.time() < deadline:
        state = _get(f"{API_BASE}/{endpoint}/status/{job_id}", api_key)
        status = str(state.get("status", "")).upper()
        if status not in ("IN_QUEUE", "IN_PROGRESS"):
            break
        time.sleep(POLL_SECONDS)
    else:
        print(f"[voice-probe] Timeout nach {args.timeout:.0f}s (Status {state.get('status')})")
        return 1

    status = str(state.get("status", "")).upper()
    output = state.get("output", state)
    print(f"[voice-probe] Status: {status}")
    print(f"[voice-probe] Kurzfassung: {summarize_output(output)}")
    print(f"[voice-probe] delayMs={state.get('delayTime')} execMs={state.get('executionTime')}")

    result: Dict[str, Any] = {
        "endpoint": endpoint,
        "jobId": job_id,
        "status": status,
        "task": args.task,
        "model": args.model,
        "delayMs": state.get("delayTime"),
        "execMs": state.get("executionTime"),
        "wallSeconds": round(time.time() - started, 1),
        "output": output,
    }

    audio_b64: Optional[str] = None
    if isinstance(output, dict):
        candidate = output.get("audioBase64") or output.get("audio")
        if isinstance(candidate, str):
            audio_b64 = candidate.split(",", 1)[1] if candidate.startswith("data:") else candidate
    if audio_b64 and args.out:
        target = pathlib.Path(args.out)
        wav_path = target.with_suffix(".wav")
        wav_path.parent.mkdir(parents=True, exist_ok=True)
        wav_path.write_bytes(base64.b64decode(audio_b64))
        info = {"path": str(wav_path), "bytes": wav_path.stat().st_size}
        try:  # Dauer/Rate nur, wenn soundfile da ist - sonst bleibt es bei Bytes
            import soundfile

            meta = soundfile.info(str(wav_path))
            info.update(
                {"sampleRate": int(meta.samplerate), "seconds": round(float(meta.frames) / float(meta.samplerate or 1), 3)}
            )
        except Exception:  # noqa: BLE001 - Zusatzinfo, kein Gate
            pass
        result["audio"] = info
        print(f"[voice-probe] Audio: {json.dumps(info)}")

    if args.out:
        path = pathlib.Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Nutzlast nicht doppelt ablegen: die WAV liegt daneben.
        trimmed = dict(result)
        if isinstance(trimmed.get("output"), dict):
            trimmed["output"] = {
                key: (f"<{len(value)} Zeichen, siehe {path.with_suffix('.wav')}>" if isinstance(value, str) and len(value) > 256 else value)
                for key, value in trimmed["output"].items()
            }
        path.write_text(json.dumps(trimmed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"[voice-probe] Messwerte: {path}")

    return 0 if status == "COMPLETED" else 1


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live-Probe der Voice-Tasks (fish-speech/OpenVoice)")
    parser.add_argument("--task", required=True, choices=("tts", "voice.convert"))
    parser.add_argument("--model", required=True)
    parser.add_argument("--text", default="Hallo, das ist ein Test der Stimmkopie.")
    parser.add_argument("--reference", default="", help="Referenzaufnahme fuer den Stimmklon")
    parser.add_argument("--reference-text", default="", dest="reference_text")
    parser.add_argument("--source", default="", help="Aufnahme, deren Timbre ersetzt wird")
    parser.add_argument("--target", default="", help="Zielstimme (Referenzclip)")
    parser.add_argument("--tau", type=float, default=0.3)
    parser.add_argument("--endpoint", default="")
    parser.add_argument("--timeout", type=float, default=1800.0)
    parser.add_argument("--out", default="")
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
