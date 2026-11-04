#!/usr/bin/env python3
"""Import Stufe 2 — eigene Kurzclips und Fotos von der BRAIN-Platte.

Quelle: /mnt/wd-elements/Videos, /mnt/wd-elements/Medien/Videos (Kurzclips)
        /mnt/wd-elements/Bilder/<Jahr> (thematische Alben)
Ziel:   R2 visuals/bank/{w,p}NNx*.mp4 + Eintrag in src/visuals/importedBank.generated.ts

Die Auswahl ist **gesichtet**: jede Datei wurde über einen Kontaktabzug geprüft.
Aufgenommen sind nur Aufnahmen **ohne Personen** und mit passendem Motiv; die
Indizes unten verweisen auf die Kandidatenlisten in
`~/.hermes/cache/scratch/{video,photo}_candidates.json` (Reihenfolge = Nummer im
Kontaktabzug).

Aufruf:  python3 scripts/visual-import/import_brain_local.py
Danach:  python3 scripts/visual-import/import_monastry.py render
         python3 scripts/visual-import/import_monastry.py upload
         python3 scripts/visual-import/import_monastry.py ts
"""
from __future__ import annotations

import json
import os
import sys
from typing import Dict, List

REPO = "/mnt/wd-elements/Medien/Projekte/audioMONASTRY"
SCRATCH = os.path.expanduser("~/.hermes/cache/scratch")
VID_CANDS = os.path.join(SCRATCH, "video_candidates.json")
PHOTO_CANDS = os.path.join(SCRATCH, "photo_candidates.json")
PLAN = os.path.join(REPO, ".visual-import", "plan.json")

sys.path.insert(0, os.path.join(REPO, "scripts", "visual-import"))
import import_monastry as imp  # noqa: E402

T_NATUR = "09_Natur-Tiere-Landschaft-HDR-Landschaft"
T_IND = "08_Industrial-Beton-Urban-LostPlaces"
T_KLOSTER = "19_Moenche-Kloster-Orden"
T_COMIC = "16_Comic-Manga-Illustration"
T_TATTOO = "15_Tattoo-Piercing-Bodymod"
T_TECHNO = "11_Techno-Rave-Klub-Laser-Neon"
T_STREET = "20_Streetart-Graffiti-Urban-Art"
T_ABSTRAKT = "03_Surreal-Abstrakt-Fraktale-Designs"

#: Video-Kandidaten (Nummer = Position im Kontaktabzug) -> Thema
VIDEO_PICK: Dict[int, str] = {
    # Natur (Landschaft, Wasser, Wald, Schnee)
    1: T_NATUR, 2: T_NATUR, 5: T_NATUR, 7: T_NATUR, 9: T_NATUR, 11: T_NATUR,
    16: T_NATUR, 21: T_NATUR, 22: T_NATUR, 23: T_NATUR, 25: T_NATUR, 26: T_NATUR,
    27: T_NATUR, 29: T_NATUR, 32: T_NATUR, 33: T_NATUR, 62: T_NATUR, 63: T_NATUR,
    64: T_NATUR, 65: T_NATUR, 68: T_NATUR, 70: T_NATUR, 71: T_NATUR, 73: T_NATUR,
    74: T_NATUR, 79: T_NATUR, 80: T_NATUR, 83: T_NATUR, 90: T_NATUR, 92: T_NATUR,
    93: T_NATUR, 95: T_NATUR, 96: T_NATUR, 97: T_NATUR, 98: T_NATUR, 100: T_NATUR,
    101: T_NATUR, 102: T_NATUR, 105: T_NATUR, 107: T_NATUR, 109: T_NATUR,
    110: T_NATUR, 112: T_NATUR, 113: T_NATUR, 117: T_NATUR, 119: T_NATUR,
    # Urban / Industrial (Straßen, Gebäude, Technik, rostiges Gerät)
    0: T_IND, 6: T_IND, 17: T_IND, 20: T_IND, 31: T_IND, 34: T_IND, 35: T_IND,
    36: T_IND, 43: T_IND, 45: T_IND, 47: T_IND, 49: T_IND, 52: T_IND, 53: T_IND,
    56: T_IND, 57: T_IND, 58: T_IND, 84: T_IND, 104: T_IND, 106: T_IND, 115: T_IND,
    # Nacht / Neon, Streetart, Kloster
    99: T_TECHNO, 78: T_STREET, 86: T_KLOSTER,
}

#: Foto-Kandidaten -> Thema
PHOTO_PICK: Dict[int, str] = {
    # Kloster / Kirche
    5: T_KLOSTER, 16: T_KLOSTER, 21: T_KLOSTER, 64: T_KLOSTER, 66: T_KLOSTER, 67: T_KLOSTER,
    # Natur
    6: T_NATUR, 7: T_NATUR, 9: T_NATUR, 11: T_NATUR, 13: T_NATUR, 23: T_NATUR,
    30: T_NATUR, 32: T_NATUR, 34: T_NATUR, 35: T_NATUR, 37: T_NATUR, 38: T_NATUR,
    39: T_NATUR, 41: T_NATUR, 42: T_NATUR, 44: T_NATUR, 47: T_NATUR, 49: T_NATUR,
    51: T_NATUR, 54: T_NATUR, 57: T_NATUR, 58: T_NATUR, 68: T_NATUR, 73: T_NATUR,
    74: T_NATUR,
    # Grafik / Abstrakt / Tattoo / Lustig
    0: T_ABSTRAKT, 40: T_ABSTRAKT, 45: T_TATTOO, 46: T_TATTOO, 61: T_TATTOO,
    53: T_COMIC, 65: T_COMIC, 81: T_COMIC, 17: T_IND,
}


def make_items() -> List[dict]:
    vids = json.load(open(VID_CANDS))
    phos = json.load(open(PHOTO_CANDS))
    items: List[dict] = []
    #: Obergrenze je Thema — sonst kippt die Show in eine Natur-Diashow
    #: (die eigene Sammlung ist zu 70 % Landschaft).
    CAP = {T_NATUR: 30}

    for n, theme in sorted(VIDEO_PICK.items()):
        if n >= len(vids):
            continue
        v = vids[n]
        mood, energy, short, nice = imp.CATEGORY_STYLE[theme]
        dur = float(v["dur"])
        items.append({
            "cid": f"w{n:03d}", "cat": theme, "kind": "video", "path": v["p"],
            "label": f"{nice} Clip {n}", "tags": [short, "eigenmaterial", "own-footage"],
            "license": "Eigenmaterial (privat)", "attribution": "Patrick (eigenes Material)",
            "source_url": "", "source": "brain", "title": f"Eigenaufnahme {os.path.basename(v['p'])[:60]}",
            "mood": mood, "energy": energy, "seconds": min(imp.CLIP_SECONDS, max(2.0, dur)),
            "width": int(v["w"]), "height": int(v["h"]),
            "start": 0.0 if dur <= imp.CLIP_SECONDS * 2 else round(dur * 0.15, 2),
            "rendered": {}, "uploaded": {},
        })

    for n, theme in sorted(PHOTO_PICK.items()):
        if n >= len(phos):
            continue
        p = phos[n]
        mood, energy, short, nice = imp.CATEGORY_STYLE[theme]
        items.append({
            "cid": f"p{n:03d}", "cat": theme, "kind": "image", "path": p["path"],
            "label": f"{nice} Foto {n}", "tags": [short, "eigenmaterial", "ken-burns"],
            "license": "Eigenmaterial (privat)", "attribution": "Patrick (eigenes Material)",
            "source_url": "", "source": "brain",
            "title": f"Eigenaufnahme {os.path.basename(p['path'])[:60]}",
            "mood": mood, "energy": energy, "seconds": imp.CLIP_SECONDS,
            "width": 0, "height": 0, "start": 0.0, "rendered": {}, "uploaded": {},
        })

    # Gleichmäßig ausdünnen, damit nicht die ersten 30 Naturmotive alle Videos sind
    for theme, cap in CAP.items():
        idx = [i for i, it in enumerate(items) if it["cat"] == theme]
        if len(idx) <= cap:
            continue
        keep = {idx[round(k * (len(idx) - 1) / (cap - 1))] for k in range(cap)}
        items = [it for i, it in enumerate(items) if i not in idx or i in keep]
    return items


def main() -> None:
    if not os.path.exists(PLAN):
        sys.exit("plan.json fehlt — erst import_monastry.py scan laufen lassen")
    plan = json.load(open(PLAN))
    have = {i["cid"] for i in plan}
    new = [i for i in make_items() if i["cid"] not in have]
    plan.extend(new)
    with open(PLAN, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, ensure_ascii=False, indent=1)
    from collections import Counter
    print(f"angehängt: {len(new)} Clips (gesamt {len(plan)})")
    for c, n in Counter(i["cat"] or i["category"] for i in plan).most_common():
        print(f"  {n:4}  {c}")


if __name__ == "__main__":
    main()
