#!/usr/bin/env python3
"""Misst, wie zuverlaessig sich die Originaldateien wiederfinden lassen.

Die Bildersammlung wurde in Jahresordner einsortiert
(Bilder/IMG_9241.JPG -> Bilder/2015/...). bilder-sortierung-umkehr.tsv
bildet den alten Basisnamen auf den neuen relativen Pfad ab.

Geprueft wird gegen ALLE sauberen Kandidaten (treffer==1, nicht ausgeschlossen)
ueber alle Themen-CSVs.
"""
from __future__ import annotations

import collections
import csv
import os
from pathlib import Path

HOME = Path("/home/patrick")
LISTEN = HOME / "am-visuals-themen-neu" / "_listen"
UMKEHR = HOME / "bilder-sortierung-umkehr.tsv"
BILDER = HOME / "Bilder"


def fnum(r: dict, k: str) -> float:
    try:
        return float(r.get(k) or 0)
    except (TypeError, ValueError):
        return 0.0


def main() -> None:
    # Umkehr-Tabelle laden
    umkehr: dict[str, str] = {}
    dup = 0
    with UMKEHR.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("alt\t") or line.startswith("#") and "\t" not in line:
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 2:
                continue
            alt, neu = parts
            if alt in umkehr and umkehr[alt] != neu:
                dup += 1
                continue
            umkehr[alt] = neu
    print(f"Umkehr-Tabelle: {len(umkehr)} Eintraege ({dup} mehrdeutige uebersprungen)")

    # Baseline: existiert die alte absolute Pfadangabe noch?
    loes = 0
    hits_umkehr = 0
    hits_null = 0
    fehlt = 0
    fehlt_bsp: list[str] = []
    total = 0
    per_theme = collections.Counter()

    for csvp in sorted(LISTEN.glob("*.csv")):
        with csvp.open("r", encoding="utf-8", errors="replace", newline="") as fh:
            for r in csv.DictReader(fh, delimiter=";"):
                if fnum(r, "treffer") != 1 or (r.get("ausschluss") or "").strip():
                    continue
                orig = (r.get("original") or "").strip()
                if not orig:
                    continue
                total += 1
                if Path(orig).exists():
                    loes += 1
                    per_theme[csvp.stem] += 1
                    continue
                base = os.path.basename(orig)
                neu = umkehr.get(base)
                if neu and (BILDER / neu).exists():
                    hits_umkehr += 1
                    per_theme[csvp.stem] += 1
                elif neu:
                    hits_null += 1
                    if len(fehlt_bsp) < 5:
                        fehlt_bsp.append(f"{base} -> {neu} (Ziel fehlt)")
                else:
                    fehlt += 1
                    if len(fehlt_bsp) < 5:
                        fehlt_bsp.append(f"{base} (kein Umkehr-Eintrag)")

    print(f"\nSaubere Kandidaten gesamt: {total}")
    print(f"  alter Pfad existiert direkt : {loes}")
    print(f"  ueber Umkehr-Tabelle geloest : {hits_umkehr}")
    print(f"  Umkehr-Eintrag, Ziel fehlt   : {hits_null}")
    print(f"  kein Umkehr-Eintrag          : {fehlt}")
    ok = loes + hits_umkehr
    print(f"  => aufloesbar: {ok}/{total} = {100.0*ok/max(1,total):.1f} %")
    print("\nBeispiele ungeloest:")
    for b in fehlt_bsp:
        print("   ", b)
    print("\nThemen mit >=25 aufloesbaren Kandidaten:")
    bad = []
    for csvp in sorted(LISTEN.glob("*.csv")):
        n = per_theme[csvp.stem]
        if n < 25:
            bad.append((csvp.stem, n))
    if not bad:
        print("   ALLE Themen haben >=25")
    else:
        for name, n in bad:
            print(f"   !! {name}: {n}")


if __name__ == "__main__":
    main()
