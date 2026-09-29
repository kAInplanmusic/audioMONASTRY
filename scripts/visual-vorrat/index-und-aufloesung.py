#!/usr/bin/env python3
"""Baut einen Datei-Index der Bildersammlung und misst die Auflösungsquote.

Strategie: Basisname -> alle Pfade unterhalb von Bilder/ (rekursiv).
Damit werden auch Dateien gefunden, die nach der Umkehr-Tabelle noch einmal
verschoben wurden.
"""
from __future__ import annotations

import collections
import csv
import json
import os
import time
from pathlib import Path

HOME = Path("/home/patrick")
LISTEN = HOME / "am-visuals-themen-neu" / "_listen"
BILDER = HOME / "Bilder"
INDEX = Path(__file__).parent / "datei-index.json"

IMG_EXT = {
    ".jpg", ".jpeg", ".png", ".heic", ".heif", ".dng", ".tif", ".tiff",
    ".webp", ".gif", ".bmp",
}
SKIP_DIRS = {"_gesichtserkennung", "proxys", ".thumbnails"}


def fnum(r: dict, k: str) -> float:
    try:
        return float(r.get(k) or 0)
    except (TypeError, ValueError):
        return 0.0


def build_index() -> dict[str, list[str]]:
    idx: dict[str, list[str]] = collections.defaultdict(list)
    t0 = time.time()
    n = 0
    for root, dirs, files in os.walk(BILDER):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if os.path.splitext(f)[1].lower() in IMG_EXT:
                idx[f].append(os.path.join(root, f))
                n += 1
    print(f"Index: {n} Bilddateien, {len(idx)} verschiedene Basisnamen ({time.time()-t0:.1f}s)")
    return dict(idx)


def main() -> None:
    if INDEX.exists():
        raw = json.loads(INDEX.read_text())
        idx: dict[str, list[str]] = {k: v for k, v in raw.items()}
        print(f"Index aus Cache: {len(idx)} Basisnamen")
    else:
        idx = build_index()
        INDEX.write_text(json.dumps(idx))
        print(f"Index geschrieben: {INDEX}")

    total = uniq = amb = miss = 0
    per_theme = collections.Counter()
    miss_bsp: list[str] = []

    for csvp in sorted(LISTEN.glob("*.csv")):
        with csvp.open("r", encoding="utf-8", errors="replace", newline="") as fh:
            for r in csv.DictReader(fh, delimiter=";"):
                if fnum(r, "treffer") != 1 or (r.get("ausschluss") or "").strip():
                    continue
                orig = (r.get("original") or "").strip()
                if not orig:
                    continue
                total += 1
                base = os.path.basename(orig)
                cands = idx.get(base, [])
                if len(cands) == 1:
                    uniq += 1
                    per_theme[csvp.stem] += 1
                elif len(cands) > 1:
                    amb += 1
                    per_theme[csvp.stem] += 1
                else:
                    miss += 1
                    if len(miss_bsp) < 6:
                        miss_bsp.append(base)

    print(f"\nSaubere Kandidaten: {total}")
    print(f"  eindeutig gefunden : {uniq}")
    print(f"  mehrdeutig (>1)    : {amb}")
    print(f"  nicht gefunden     : {miss}")
    ok = uniq + amb
    print(f"  => aufloesbar: {ok}/{total} = {100.0*ok/max(1,total):.1f} %")
    print("\nBeispiele nicht gefunden:", ", ".join(miss_bsp) or "-")

    print("\nThemen unter 25 aufloesbaren Kandidaten:")
    bad = [(p.stem, per_theme[p.stem]) for p in sorted(LISTEN.glob("*.csv")) if per_theme[p.stem] < 25]
    if not bad:
        print("   KEINE - alle Themen haben >=25")
    else:
        for n, c in bad:
            print(f"   !! {n}: {c}")


if __name__ == "__main__":
    main()
