#!/usr/bin/env python3
"""Prueft die Themen-Zuordnung und die Caption-Herkunft an den Rohdaten.

Fragen:
  1. Ist die Spalte 'tags' je Bild in allen Themen-CSVs gleich (dann ist sie
     querkontaminiert) oder themenspezifisch?
  2. Wie stark ueberschneiden sich die Themen? (Spalte 'themen' je Bild)
  3. Wie wurden die 25 Ordnerbilder ausgewaehlt? (aesthetik/treffer)
"""
from __future__ import annotations

import collections
import csv
import json
import os
from pathlib import Path

HOME = Path("/home/patrick")
SRC = HOME / "am-visuals-themen-neu"
LISTEN = SRC / "_listen"


def load(csv_path: Path) -> list[dict]:
    with csv_path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        return list(csv.DictReader(fh, delimiter=";"))


def main() -> None:
    themes = sorted(p.stem for p in LISTEN.glob("*.csv"))
    by_theme: dict[str, dict[str, dict]] = {}
    for t in themes:
        rows = load(LISTEN / f"{t}.csv")
        by_theme[t] = {os.path.basename((r.get("original") or "").strip()): r for r in rows if r.get("original")}

    print(f"CSVs: {len(themes)}")

    # --- 1. tags je Bild ueber Themen hinweg vergleichen ---
    seen: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)
    for t, rows in by_theme.items():
        for base, r in rows.items():
            if len(base) > 3:
                seen[base].append((t, (r.get("tags") or "").strip()))
    multi = {b: v for b, v in seen.items() if len(v) > 1}
    identical = sum(1 for v in multi.values() if len({x[1] for x in v}) == 1)
    print(f"\n1) Bilder in mehreren CSVs: {len(multi)}  |  davon mit IDENTISCHEN tags: {identical}")
    for b, v in list(multi.items())[:3]:
        print(f"   {b}: {len(v)} Themen -> tags identisch: {len({x[1] for x in v}) == 1}")

    # --- 2. Ueberschneidung: wie viele Themen hat ein Bild? ---
    hits = collections.Counter()
    for t, rows in by_theme.items():
        for base, r in rows.items():
            try:
                hits[int(float(r.get("treffer") or 0))] += 1
            except ValueError:
                pass
    print("\n2) Verteilung 'treffer' (Anzahl Themen je Bild), Top 12:")
    for k, v in sorted(hits.items())[:12]:
        print(f"   {k:3d} Themen: {v:6d} Bilder")

    # --- 3. Auswahl der Ordnerbilder ---
    print("\n3) Auswahl der 25 Ordnerbilder je Thema (aesthetik/treffer):")
    print(f"   {'Thema':36} {'im Ordner':>10} {'aesth(min/med)':>16} {'treffer(med)':>13} {'CSV-Zeilen':>10}")
    summary = {}
    for t in themes:
        d = SRC / t
        if not d.is_dir():
            continue
        files = {p.name for p in d.iterdir() if p.is_file()}
        rows = by_theme[t]
        sel = [rows[f] for f in files if f in rows]
        allr = list(rows.values())

        def num(rs, k):
            out = []
            for r in rs:
                try:
                    out.append(float(r.get(k) or 0))
                except ValueError:
                    pass
            return out

        sa = num(sel, "aesthetik")
        aa = num(allr, "aesthetik")
        st = num(sel, "treffer")
        at = num(allr, "treffer")
        med = lambda x: sorted(x)[len(x) // 2] if x else 0
        print(
            f"   {t:36} {len(sel):>10} {min(sa) if sa else 0:>7.2f}/{med(sa):>6.2f} "
            f"{med(st):>13.0f} {len(allr):>10}"
        )
        summary[t] = {
            "selected": len(sel),
            "csv_rows": len(allr),
            "aesth_selected_min": min(sa) if sa else None,
            "aesth_selected_median": med(sa),
            "aesth_all_median": med(aa),
            "treffer_selected_median": med(st),
            "treffer_all_median": med(at),
        }
    Path("analyse-themen.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n-> analyse-themen.json geschrieben")


if __name__ == "__main__":
    main()
