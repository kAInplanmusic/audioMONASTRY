#!/usr/bin/env python3
"""`workflows/music.json` reproduzierbar aus dem offiziellen ComfyUI-Template bauen.

Herkunft (nicht geraten):
* Struktur: offizielles ComfyUI-Template `templates/audio_ace_step1_5_xl_turbo.json`
  aus https://github.com/Comfy-Org/workflow_templates (ACE-Step 1.5 XL Turbo).
* Namen der Ein-/Ausgaenge: Quellen der im Image eingesetzten ComfyUI-Version
  (v0.32.0 laut Dockerfile des ACE-Step-Templates): `comfy_extras/nodes_ace.py`
  fuer die ACE-Knoten, `comfy_extras/nodes_audio.py` fuer die Audio-Ausgabe.

Eine bewusste Abweichung vom Template: der Speicherknoten wird von
`SaveAudioAdvanced` auf `SaveAudioMP3` getauscht. `SaveAudioAdvanced` traegt eine
DynamicCombo (`format` + optionale `quality`) - live am 2026-09-16 kam der Job
damit als "Required input is missing: quality" zurueck. `SaveAudioMP3` ist genau
der Knoten, den das offizielle Schwester-Template
(`templates/audio_ace_step_1_5_split_4b.json`) benutzt.

    python3 scripts/build-music-workflow.py            # schreibt workflows/music.json
    python3 scripts/build-music-workflow.py --dry-run  # nur zeigen
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import sys
import urllib.request
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONVERTER = ROOT / "scripts" / "comfyui-ui-to-api.py"
TARGET = ROOT / "services" / "audiomonastry-ai-runtime" / "workflows" / "music.json"
TEMPLATE_URL = (
    "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/"
    "templates/audio_ace_step1_5_xl_turbo.json"
)
#: Knoten-Kennung des Speicherknotens im Upstream-Template, der ersetzt wird.
SAVE_NODE_ID = 111


def load_converter() -> Any:
    spec = importlib.util.spec_from_file_location("comfyui_ui_to_api", CONVERTER)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"Umwandler nicht ladbar: {CONVERTER}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_template(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310 (feste URL)
        return json.loads(response.read().decode("utf-8"))


def swap_save_node(graph: dict[str, Any]) -> None:
    """SaveAudioAdvanced -> SaveAudioMP3 (siehe Modul-Docstring)."""
    for node in graph["nodes"]:
        if node["id"] == SAVE_NODE_ID:
            if node["type"] != "SaveAudioAdvanced":
                raise SystemExit(f"Knoten {SAVE_NODE_ID} ist {node['type']}, erwartet SaveAudioAdvanced")
            node["type"] = "SaveAudioMP3"
            node["widgets_values"] = ["audio/ACESTEP", "V0"]
            return
    raise SystemExit(f"Knoten {SAVE_NODE_ID} im Template nicht gefunden")


def main() -> int:
    parser = argparse.ArgumentParser(description="music.json aus dem offiziellen Template bauen")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--url", default=TEMPLATE_URL)
    args = parser.parse_args()

    converter = load_converter()
    graph = load_template(args.url)
    swap_save_node(graph)
    try:
        api, notes = converter.ui_to_api(graph)
    except ValueError as exc:
        print(f"[build-music] FEHLER: {exc}", file=sys.stderr)
        return 1
    for note in notes:
        print(f"[build-music] Hinweis: {note}", file=sys.stderr)

    text = json.dumps(api, indent=2, ensure_ascii=False) + "\n"
    if args.dry_run:
        print(text)
        return 0
    TARGET.write_text(text, encoding="utf-8")
    print(f"[build-music] {len(api)} Knoten -> {TARGET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
