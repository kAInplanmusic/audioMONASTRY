#!/usr/bin/env python3
"""ComfyUI-Workflow vom UI-Format ins API-Format umwandeln (RUNPOD-P1-001).

Warum es das gibt
-----------------
Der `comfyui_adapter.py` braucht Workflows im **API-Format** (Objekt aus
Knoten-IDs auf `{class_type, inputs}`). Die ComfyUI-UI speichert normalerweise das
UI-Format (`nodes`/`links`). Bisher hiess es deshalb: „einmal aus der UI mit
Workflow -> Export (API) exportieren“. Dieses Skript macht dieselbe Umformung
nachvollziehbar und pruefbar – ohne UI, ohne GPU:

    python3 scripts/comfyui-ui-to-api.py templates.json workflows/music.json

Die Widget-Namen je Knotenklasse sind NICHT geraten, sondern aus den Quellen der
eingesetzten ComfyUI-Version abgeschrieben (siehe WIDGETS unten; ACE-Step-Knoten
aus `comfy_extras/nodes_ace.py`). Frontend-only-Knoten (PrimitiveNode,
PrimitiveInt, Note/MarkdownNote, Reroute) existieren im API-Format nicht: Werte
werden in die verdrahteten Eingaenge hineingezogen, genau wie es die UI beim
Export tut. Das Skript bricht ab, wenn etwas nicht aufgeht – eine still
verwurschtelte Umwandlung ist schlimmer als keine.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any, Dict, List, Optional, Tuple

#: Knotenklasse -> geordnete Widget-Namen (Reihenfolge wie in der UI-JSON).
#: `skip` nennt Positionen, die reine Frontend-Schalter sind und im API-Format
#: nicht auftauchen (z. B. `control_after_generate` hinter `seed`).
WIDGETS: Dict[str, Dict[str, Any]] = {
    "UNETLoader": {"names": ["unet_name", "weight_dtype"]},
    "CheckpointLoaderSimple": {"names": ["ckpt_name"]},
    "CLIPLoader": {"names": ["clip_name", "type", "device"]},
    "DualCLIPLoader": {"names": ["clip_name1", "clip_name2", "type", "device"]},
    "VAELoader": {"names": ["vae_name"]},
    "ModelSamplingAuraFlow": {"names": ["shift"]},
    "KSampler": {"names": ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"], "skip": [1]},
    "EmptyAceStepLatentAudio": {"names": ["seconds", "batch_size"]},
    "EmptyAceStep1.5LatentAudio": {"names": ["seconds", "batch_size"]},
    "TextEncodeAceStepAudio": {"names": ["tags", "lyrics", "lyrics_strength"]},
    "TextEncodeAceStepAudio1.5": {
        "names": [
            "tags",
            "lyrics",
            "seed",
            "bpm",
            "duration",
            "timesignature",
            "language",
            "keyscale",
            "generate_audio_codes",
            "cfg_scale",
            "temperature",
            "top_p",
            "top_k",
            "min_p",
        ],
        "skip": [3],
    },
    "VAEDecodeAudio": {"names": []},
    "ConditioningZeroOut": {"names": []},
    "SaveAudio": {"names": ["filename_prefix"]},
    "SaveAudioMP3": {"names": ["filename_prefix", "quality"]},
    "PreviewAudio": {"names": []},
    "LoadAudio": {"names": ["audio"]},
}

#: Knoten, die sich mit dieser Tabelle NICHT korrekt abbilden lassen. Sie werden
#: mit Begruendung abgelehnt, statt ein falsches API-Objekt zu erzeugen. Live
#: belegt am 2026-09-16: `SaveAudioAdvanced` kam so durch und ComfyUI lehnte den
#: Job mit "Required input is missing: quality" ab.
UNSUPPORTED: Dict[str, str] = {
    "SaveAudioAdvanced": (
        "nutzt eine DynamicCombo (format + optionale quality). Im API-Format braucht die einen "
        "verschachtelten Wert -> SaveAudio oder SaveAudioMP3 verwenden"
    ),
}

#: Knoten, die es nur im Frontend gibt (Werte werden inline weitergereicht).
FRONTEND_ONLY = {"PrimitiveNode", "PrimitiveInt", "PrimitiveFloat", "PrimitiveString", "MarkdownNote", "Note", "Reroute"}


def ui_to_api(graph: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """UI-Graph -> (API-Graph, Hinweisliste). Wirft bei Unstimmigkeiten."""
    nodes = {node["id"]: node for node in graph.get("nodes", [])}
    links = {link[0]: link for link in graph.get("links", []) if isinstance(link, list) and len(link) >= 5}
    notes: List[str] = []
    api: Dict[str, Any] = {}

    def resolve(value_link: int, target_class: str, target_input: str) -> Any:
        link = links.get(value_link)
        if link is None:
            raise ValueError(f"{target_class}.{target_input}: Link {value_link} fehlt in 'links'")
        origin_id, origin_slot = link[1], link[2]
        origin = nodes.get(origin_id)
        if origin is None:
            raise ValueError(f"{target_class}.{target_input}: Quellknoten {origin_id} fehlt")
        if origin["type"] in FRONTEND_ONLY:
            # PrimitiveNode/PrimitiveInt tragen den Wert selbst; im API-Format
            # wird er direkt in den Eingang geschrieben.
            widgets = origin.get("widgets_values") or []
            if not widgets:
                raise ValueError(f"{target_class}.{target_input}: Primitive {origin_id} ohne Wert")
            return widgets[0]
        return [str(origin_id), origin_slot]

    # Erster Durchgang: alle Knoten anlegen und ihre Widget-Werte eintragen.
    # (Die Reihenfolge in der UI-JSON ist nicht topologisch, Links koennen also
    # auf spaeter stehende Knoten zeigen.)
    for node in graph.get("nodes", []):
        class_type = node["type"]
        if class_type in FRONTEND_ONLY:
            continue
        if class_type in UNSUPPORTED:
            raise ValueError(f"Knoten {node['id']} ({class_type}): {UNSUPPORTED[class_type]}")
        spec = WIDGETS.get(class_type)
        if spec is None:
            raise ValueError(f"Unbekannte Knotenklasse {class_type!r} – WIDGETS ergaenzen (nicht raten)")
        if node.get("mode") in (2, 4):  # 2 = muted, 4 = bypassed
            notes.append(f"Knoten {node['id']} ({class_type}) ist stumm/umgangen und wird weggelassen")
            continue

        widgets = list(node.get("widgets_values") or [])
        skip = set(spec.get("skip") or [])
        if len(widgets) - len(skip) != len(spec["names"]):
            raise ValueError(
                f"Knoten {node['id']} ({class_type}): {len(widgets)} Widget-Werte, erwartet "
                f"{len(spec['names'])} (+{len(skip)} Frontend-Schalter) – WIDGETS pruefen"
            )
        values = [value for position, value in enumerate(widgets) if position not in skip]
        api[str(node["id"])] = {
            "class_type": class_type,
            "inputs": dict(zip(spec["names"], values)),
        }

    # Zweiter Durchgang: verdrahtete Eingaenge aufloesen. Ein Link gewinnt gegen
    # den Widget-Wert – so arbeitet auch die UI.
    for node in graph.get("nodes", []):
        if node["type"] in FRONTEND_ONLY or str(node["id"]) not in api:
            continue
        for entry in node.get("inputs") or []:
            if entry.get("link") is not None:
                api[str(node["id"])]["inputs"][entry["name"]] = resolve(
                    entry["link"], node["type"], entry["name"]
                )

    if not api:
        raise ValueError("Kein ausfuehrbarer Knoten im Graph")
    return api, notes


def main() -> int:
    parser = argparse.ArgumentParser(description="ComfyUI UI-Format -> API-Format")
    parser.add_argument("source", help="UI-Workflow (JSON)")
    parser.add_argument("target", nargs="?", help="Zieldatei (sonst stdout)")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    graph = json.loads(pathlib.Path(args.source).read_text(encoding="utf-8"))
    try:
        api, notes = ui_to_api(graph)
    except ValueError as exc:
        print(f"[ui-to-api] FEHLER: {exc}", file=sys.stderr)
        return 1

    text = json.dumps(api, indent=2, ensure_ascii=False) + "\n"
    if args.target:
        pathlib.Path(args.target).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    if not args.quiet:
        print(f"[ui-to-api] {len(api)} Knoten umgesetzt -> {args.target or 'stdout'}", file=sys.stderr)
        for note in notes:
            print(f"[ui-to-api] Hinweis: {note}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
