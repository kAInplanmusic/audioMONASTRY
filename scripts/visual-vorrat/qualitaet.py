#!/usr/bin/env python3
"""Bewertet jedes Themen-LoRA an seinem Probe-Bild - messbar, nicht nach Gefuehl.

Je Thema wird das Probe-Bild des letzten Schritts geprueft:
  * Standardabweichung der Graustufen  -> "flaechig" vs. "strukturiert"
  * Kantenenergie (mittlerer Gradient) -> wieviel Detail steckt drin
  * Farbstreuung ueber die Kanaele

Ein Stil-LoRA, das nur eine leere Flaeche erzeugt, hat den Stil NICHT gelernt -
das ist am Bild sofort zu sehen und hier zusaetzlich als Zahl belegt.
"""
from __future__ import annotations

import io
import json
import re
import tarfile
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

import r2

BASE = Path(__file__).parent
OUT = BASE / "ergebnisse" / "qualitaet.json"

# Schwellen aus der Messung selbst (siehe Ausgabe): strukturlose Bilder liegen
# deutlich unter 20 Graustufen Standardabweichung.
STD_WEAK = 20.0
EDGE_WEAK = 3.0


def fetch(key: str) -> bytes:
    c = r2._creds()
    url = r2.presign("GET", f"lora-out/{key}", **c, expires=3600)
    return urllib.request.urlopen(url, timeout=300).read()


def last_sample(theme: str) -> Image.Image | None:
    try:
        data = fetch(f"{theme}/samples.tar")
    except Exception:
        return None
    tf = tarfile.open(fileobj=io.BytesIO(data))
    best, best_step = None, -1
    for m in tf.getmembers():
        if not m.name.endswith(".jpg") or m.name.endswith(".jpg.jpg"):
            continue
        mm = re.search(r"_(\d{9})_0\.jpg$", m.name)
        if mm and int(mm.group(1)) > best_step:
            best_step, best = int(mm.group(1)), m
    if best is None:
        return None
    return Image.open(io.BytesIO(tf.extractfile(best).read())).convert("RGB")


def main() -> int:
    themes = sorted(p.name for p in (BASE / "out-v3").iterdir()
                    if p.is_dir() and (p / "images").is_dir())
    rows = []
    for t in themes:
        img = last_sample(t)
        if img is None:
            rows.append({"theme": t, "status": "kein_probebild"})
            continue
        g = np.asarray(img.convert("L"), dtype=np.float32)
        rgb = np.asarray(img, dtype=np.float32)
        edges = np.asarray(img.convert("L").filter(ImageFilter.FIND_EDGES), dtype=np.float32)
        std = float(g.std())
        edge = float(edges.mean())
        colour = float(rgb.reshape(-1, 3).std(axis=0).mean())
        verdict = "gut" if (std >= STD_WEAK and edge >= EDGE_WEAK) else "flaechig"
        rows.append({"theme": t, "std": round(std, 1), "edge": round(edge, 1),
                     "colour": round(colour, 1), "verdict": verdict})

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    ok = [r for r in rows if r.get("verdict") == "gut"]
    weak = [r for r in rows if r.get("verdict") == "flaechig"]
    missing = [r for r in rows if r.get("verdict") is None]

    print(f"{'Thema':34} {'Graustufen-Std':>14} {'Kanten':>8} {'Urteil':>10}")
    for r in sorted(rows, key=lambda x: x.get("std", 0)):
        if r.get("verdict") is None:
            print(f"{r['theme']:34} {'-':>14} {'-':>8} {r['status']:>10}")
        else:
            print(f"{r['theme']:34} {r['std']:14.1f} {r['edge']:8.1f} {r['verdict']:>10}")

    print(f"\nStrukturiert (Stil sichtbar): {len(ok)}")
    print(f"Flaechenhaft (Stil fragwuerdig): {len(weak)} -> {', '.join(r['theme'] for r in weak) or '-'}")
    if missing:
        print(f"Ohne Probebild: {len(missing)} -> {', '.join(r['theme'] for r in missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
