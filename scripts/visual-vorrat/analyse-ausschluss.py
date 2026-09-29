#!/usr/bin/env python3
"""Klaert die Spalte 'ausschluss' und waehlt die sauberen Bilder je Thema aus.

Frage: Sind die 25 Bilder im Themenordner 'ausschluss'-frei? Und wie viele
Bilder sind gleichzeitig eindeutig (treffer==1) UND nicht ausgeschlossen?
"""
from __future__ import annotations

import csv
import os
from pathlib import Path

SRC = Path("/home/patrick/am-visuals-themen-neu")
LISTEN = SRC / "_listen"


def load(p: Path) -> list[dict]:
    with p.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        return list(csv.DictReader(fh, delimiter=";"))


def fnum(r: dict, k: str) -> float:
    try:
        return float(r.get(k) or 0)
    except (TypeError, ValueError):
        return 0.0


def main() -> None:
    themes = sorted(p.stem for p in LISTEN.glob("*.csv"))
    print(f"{'Thema':34} {'Ordner':>6} {'Ordner ausschl=ja':>17} {'t=1 & ausschl=leer':>19}")
    total_ok = 0
    for t in themes:
        rows = load(LISTEN / f"{t}.csv")
        d = SRC / t
        files = {p.name for p in d.iterdir() if p.is_file()} if d.is_dir() else set()
        in_folder = [r for r in rows if os.path.basename((r.get("original") or "").strip()) in files]
        folder_excl = sum(1 for r in in_folder if (r.get("ausschluss") or "").strip())
        clean = [r for r in rows if fnum(r, "treffer") == 1 and not (r.get("ausschluss") or "").strip()]
        if len(clean) >= 25:
            total_ok += 1
        mark = "OK " if len(clean) >= 25 else "!! "
        print(f"{mark}{t:32} {len(in_folder):>6} {folder_excl:>17} {len(clean):>19}")

    print(f"\nThemen mit >=25 sauberen Bildern (treffer=1, nicht ausgeschlossen): {total_ok}/{len(themes)}")


if __name__ == "__main__":
    main()
