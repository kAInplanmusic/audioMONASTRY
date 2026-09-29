#!/usr/bin/env python3
"""Prueft, wie viele EINDEUTIGE Bilder je Thema verfuegbar sind.

Kriterium: Spalte 'treffer' = Anzahl der Themen, zu denen ein Bild passt.
treffer == 1  -> das Bild gehoert eindeutig zu genau diesem Thema (sauber).
treffer >= 4  -> generisches Bild, passt ueberall (untauglich als Stilbeispiel).

Zusaetzlich: Verteilung der Spalte 'ausschluss' und der NSFW-Werte.
"""
from __future__ import annotations

import collections
import csv
import json
import os
from pathlib import Path

SRC = Path("/home/patrick/am-visuals-themen-neu")
LISTEN = SRC / "_listen"


def load(p: Path) -> list[dict]:
    with p.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        return list(csv.DictReader(fh, delimiter=";"))


def fnum(row: dict, key: str) -> float:
    try:
        return float(row.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def main() -> None:
    themes = sorted(p.stem for p in LISTEN.glob("*.csv"))
    ausschluss = collections.Counter()
    nsfw_buckets = collections.Counter()
    report = {}

    print(f"{'Thema':36} {'CSV':>6} {'t=1':>6} {'t<=2':>6} {'t<=3':>6} {'auss':>5} {'top25 t=1/2/3':>15}")
    for t in themes:
        rows = load(LISTEN / f"{t}.csv")
        for r in rows:
            a = (r.get("ausschluss") or "").strip()
            if a:
                ausschluss[a[:40]] += 1
            n = fnum(r, "nsfw")
            nsfw_buckets["0" if n == 0 else "0-0.2" if n < 0.2 else "0.2-0.5" if n < 0.5 else ">=0.5"] += 1

        t1 = [r for r in rows if fnum(r, "treffer") == 1]
        t2 = [r for r in rows if fnum(r, "treffer") <= 2]
        t3 = [r for r in rows if fnum(r, "treffer") <= 3]

        # Nach Aesthetik sortierte Kandidaten je Stufe: reichen 25?
        def top(rr: list[dict]) -> list[dict]:
            return sorted(rr, key=lambda r: -fnum(r, "aesthetik"))[:25]

        ok = []
        for lvl, pool in ((1, t1), (2, t2), (3, t3)):
            ok.append(len(top(pool)) if len(pool) >= 25 else 0)
        print(
            f"{t:36} {len(rows):>6} {len(t1):>6} {len(t2):>6} {len(t3):>6} "
            f"{sum(1 for r in rows if (r.get('ausschluss') or '').strip()):>5} "
            f"{len(top(t1)) if len(t1)>=25 else 0:>5}/{len(top(t2)) if len(t2)>=25 else 0:>4}/{len(top(t3)) if len(t3)>=25 else 0:>4}"
        )
        report[t] = {
            "csv_rows": len(rows),
            "treffer_eq_1": len(t1),
            "treffer_le_2": len(t2),
            "treffer_le_3": len(t3),
            "can_fill_25_with_treffer_le_1": len(t1) >= 25,
            "can_fill_25_with_treffer_le_2": len(t2) >= 25,
            "can_fill_25_with_treffer_le_3": len(t3) >= 25,
        }

    print("\n=== ausschluss-Werte ===")
    for k, v in ausschluss.most_common(10):
        print(f"  {v:6d}  {k!r}")
    if not ausschluss:
        print("  (keine)")

    print("\n=== NSFW-Verteilung ueber alle Zeilen ===")
    for k, v in nsfw_buckets.most_common():
        print(f"  {k:8} {v:6d}")

    Path("analyse-eindeutig.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    themes_ok1 = sum(1 for v in report.values() if v["can_fill_25_with_treffer_le_1"])
    themes_ok2 = sum(1 for v in report.values() if v["can_fill_25_with_treffer_le_2"])
    print(f"\nThemen mit 25 sauberen Bildern: treffer<=1: {themes_ok1}/{len(report)}  |  treffer<=2: {themes_ok2}/{len(report)}")
    print("-> analyse-eindeutig.json geschrieben")


if __name__ == "__main__":
    main()
