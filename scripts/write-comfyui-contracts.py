#!/usr/bin/env python3
"""Gepinnte ComfyUI-Kontrakte als review-baren Beleg schreiben (ohne base64).

Quelle sind die vollstaendigen Rohantworten aus logs/probes/ (gitignored, weil
base64-Nutzlasten mehrere MB gross sind). Diese Datei haelt fest, was am
2026-09-16 live gemessen wurde: Anfrage, Antwortfelder, Typen und GROESSEN -
genug, um den Adapter und den Vertrag zu pruefen, ohne Megabytes im Repo.

    python3 scripts/write-comfyui-contracts.py
"""
from __future__ import annotations

import base64
import json
import pathlib
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROBE_DIR = ROOT / "logs" / "probes"
OUT = ROOT / "services" / "audiomonastry-ai-runtime" / "workflows" / "contracts-20260916.json"


def describe(value: Any) -> Any:
    """Feld beschreiben: Typ + Groesse, bei base64 zusaetzlich die ersten Bytes."""
    if isinstance(value, str):
        entry: dict[str, Any] = {"type": "str", "chars": len(value)}
        if value.startswith("data:"):
            head, _, payload = value.partition(",")
            entry["dataUri"] = head
            entry["decodedBytes"] = len(base64.b64decode(payload))
        elif len(value) > 256:
            entry["looksLikeRawBase64"] = True
            try:
                entry["decodedBytes"] = len(base64.b64decode(value))
                entry["decodedPrefixHex"] = base64.b64decode(value)[:8].hex()
            except Exception:  # noqa: BLE001 - nur eine Beschreibung
                entry["decodedBytes"] = None
        return entry
    if isinstance(value, list):
        return {"type": "list", "len": len(value), "first": describe(value[0]) if value else None}
    if isinstance(value, dict):
        return {"type": "dict", "keys": sorted(value.keys())}
    return {"type": type(value).__name__, "value": value}


def main() -> int:
    cases = [
        ("imageHq", "imagehq-prompt-20260916.json"),
        ("music", "music-health-20260916.json"),
        ("videoAbstract", "videoabstract-empty-workflow-20260916.json"),
    ]
    document: dict[str, Any] = {
        "measuredAt": "2026-09-16",
        "method": "scripts/runpod-comfyui-probe.py je Rolle, ein Job (Rohantworten in logs/probes/, gitignored)",
        "roles": {},
    }
    for role, filename in cases:
        path = PROBE_DIR / filename
        if not path.is_file():
            print(f"[contracts] fehlt (uebersprungen): {path}")
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        document["roles"][role] = {"response": {key: describe(value) for key, value in raw.items()}}
        print(f"[contracts] {role}: {sorted(raw.keys())}")

    # videoReal: die Rohantwort war im Probe-Log (4000-Zeichen-Deckel) abgeschnitten
    # und wurde deshalb nicht als Datei gespeichert - hier nur die gemessene Form.
    document["roles"]["videoReal"] = {
        "response": {"video": {"type": "str", "note": "rohes base64 MP4, KEIN data:-Praefix; beginnt mit der ftyp-Box"}},
        "note": "gemessen im Probe-Log 2026-09-16 (Job COMPLETED in 4m17s); kein --out, weil der Lauf vor dem Schalter stattfand",
    }

    OUT.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[contracts] geschrieben: {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
