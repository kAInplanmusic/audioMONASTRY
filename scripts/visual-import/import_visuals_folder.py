#!/usr/bin/env python3
"""Import des Ordners `/mnt/wd-elements/VISUALS` (eigene Bildsammlung).

148 Dateien, gesichtet über Kontaktabzüge (5 Blätter). Aufgenommen sind 106
Motive ohne echte Personen und ohne eingebrannte Logos/Texte; 42 fliegen raus
(Porträts, Hände, Tarot-Karten mit Text, Markenlogos).

Ids: `vNNN` (Index der sortierten Dateiliste). Themenzuordnung stammt aus der
Sichtung, nicht aus Dateinamen (die sind UUIDs).

Aufruf:  python3 scripts/visual-import/import_visuals_folder.py
Danach:  import_monastry.py render / upload / ts
"""
from __future__ import annotations

import json
import os
import sys
from typing import Dict, List

REPO = "/mnt/wd-elements/Medien/Projekte/audioMONASTRY"
SRC = "/mnt/wd-elements/VISUALS"
SCRATCH = os.path.expanduser("~/.hermes/cache/scratch")
PLAN = os.path.join(REPO, ".visual-import", "plan.json")

sys.path.insert(0, os.path.join(REPO, "scripts", "visual-import"))
import import_monastry as imp  # noqa: E402

T_WELTALL = "05_Weltall-Galaxie-Sterne-Planeten-Milchstrasse-Universum"
T_FANTASY = "07_Fantasy-Tolkien-Drachen-Dinos-Hexen-Hochkulturen"
T_DAEMON = "18_Teufel-Geister-Daemonen-Inferno"
T_ABSTRAKT = "03_Surreal-Abstrakt-Fraktale-Designs"
T_MACRO = "04_Macro-Naturmakro-Miniatur-Nahaufnahmen"
T_NATUR = "09_Natur-Tiere-Landschaft-HDR-Landschaft"
T_MALER = "17_Maler-Groesste-Meister"
T_KLOSTER = "19_Moenche-Kloster-Orden"
T_IND = "08_Industrial-Beton-Urban-LostPlaces"
T_TECHNO = "11_Techno-Rave-Klub-Laser-Neon"
T_AKT = "06_Sexy-Frauen-Akt-Dessous-Romantik"
T_COMIC = "16_Comic-Manga-Illustration"
T_LUSTIG = "14_8bit-Retro-Games-Arcade"
T_ZOMBIE = "01_Zombie-Apoklapse-Horror-Pandemie".replace("Apoklapse", "Apokalypse")

#: Themenzuordnung aus der Sichtung (Index = Position in der sortierten Liste)
THEME_BY_INDEX: Dict[str, List[int]] = {
    T_WELTALL: [7, 9, 71, 73, 77, 81, 82, 95, 126, 127, 129, 130, 131, 132, 134, 137,
                141, 142, 143, 144, 145, 146, 147],
    T_FANTASY: [14, 22, 32, 33, 58, 90, 61, 62, 70, 74, 75, 76, 78, 79, 80, 83, 85, 86, 88, 89, 91,
                93, 133, 136, 139],
    T_DAEMON: [1, 4, 10, 16, 19, 36, 37, 51, 56, 52, 53, 54, 55, 59, 60, 63, 65, 69, 122,
               123, 138, 140],
    T_ABSTRAKT: [12, 17, 20, 28, 87, 135],
    T_MACRO: [39, 40, 45, 46, 47, 48, 49],
    T_NATUR: [21, 41, 42, 43, 44, 50, 67, 68, 107, 119],
    T_MALER: [2, 3, 25, 26, 27, 35],
    T_KLOSTER: [34, 72, 84],
    T_IND: [5, 13, 24, 30, 125],
    T_TECHNO: [29, 66],
    T_AKT: [64],
    T_COMIC: [31],
    T_LUSTIG: [99, 104],
    T_ZOMBIE: [0],
}

#: Bewusst aussortiert (echte Personen, Hände, Logos/Text, Tarot-Karten).
SKIPPED = [6, 8, 11, 15, 18, 23, 38, 57, 92, 94, 96, 97, 98, 100, 101, 102, 103, 105, 106,
           108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 120, 121, 124, 128]


def main() -> None:
    files = sorted(f for f in os.listdir(SRC) if f.lower().endswith((".png", ".jpg", ".jpeg")))
    if not os.path.exists(PLAN):
        sys.exit("plan.json fehlt — erst import_monastry.py scan laufen lassen")
    plan = json.load(open(PLAN, encoding="utf-8"))
    have = {i["cid"] for i in plan}

    chosen: List[tuple] = []
    for theme, idxs in THEME_BY_INDEX.items():
        for n in idxs:
            chosen.append((n, theme))
    chosen.sort()

    new = []
    for n, theme in chosen:
        cid = f"v{n:03d}"
        if cid in have or n >= len(files):
            continue
        mood, energy, short, nice = imp.CATEGORY_STYLE[theme]
        new.append({
            "cid": cid, "cat": theme, "kind": "image", "path": os.path.join(SRC, files[n]),
            "label": f"{nice} {n}", "tags": [short, "eigenmaterial", "ken-burns", "visuals-ordner"],
            "license": "Eigenmaterial (privat)", "attribution": "Patrick (eigenes Material)",
            "source_url": "", "source": "wd-visuals",
            "title": f"Eigenmotiv {files[n][:28]}",
            "mood": mood, "energy": energy, "seconds": imp.CLIP_SECONDS,
            "width": 0, "height": 0, "start": 0.0, "rendered": {}, "uploaded": {},
        })

    plan.extend(new)
    with open(PLAN, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, ensure_ascii=False, indent=1)
    from collections import Counter
    print(f"angehängt: {len(new)} Clips (gesamt {len(plan)}), aussortiert: {len(SKIPPED)}")
    print(Counter(i["cat"][:28] for i in new).most_common())


if __name__ == "__main__":
    main()
