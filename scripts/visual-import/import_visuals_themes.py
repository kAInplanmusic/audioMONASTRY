#!/usr/bin/env python3
"""Import der **themen-sortierten** Bild- und Videoordner in `/mnt/wd-elements/VISUALS`.

Neu gegenüber Stufe 3: die Sammlung liegt jetzt in 14 Themenordnern
(`01-wwi-duester/` … `14-zitate/`), dazu 23 fertige Kurzvideos im Wurzelordner
(`01-wwi-duester-1.mp4`, `fantasy.mp4`, …). Die Bilder im Wurzelordner sind
bereits in Stufe 3 abgearbeitet (114 aufgenommen, 34 wegen Personen/Logos
bewusst nicht) und werden hier **nicht** erneut angefasst.

Ids sind **inhaltlich stabil**: `n` + 6 Zeichen aus dem SHA-1 des relativen
Pfads. Damit verschiebt das Umsortieren von Dateien keine Zuordnung (anders als
die positionsbasierten `vNNN`, die aus Stufe 3 stammen).

Aufruf:  python3 scripts/visual-import/import_visuals_themes.py
Danach:  import_monastry.py render / upload ; reconcile_bank.py ; import_monastry.py ts
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from typing import Dict, List

REPO = "/mnt/wd-elements/Medien/Projekte/audioMONASTRY"
SRC = "/mnt/wd-elements/VISUALS"
PLAN = os.path.join(REPO, ".visual-import", "plan.json")

sys.path.insert(0, os.path.join(REPO, "scripts", "visual-import"))
import import_monastry as imp  # noqa: E402

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}
VID_EXT = {".mp4", ".mov", ".webm", ".mkv"}

#: Ordnername (bzw. Dateinamen-Präfix bei den Wurzelvideos) -> Kategorie
THEME_BY_KEY: Dict[str, str] = {
    "01-wwi-duester": "02_Kriegsdystopie-1-und-2-Weltkrieg",
    "wwi": "02_Kriegsdystopie-1-und-2-Weltkrieg",
    "02-weltall": "05_Weltall-Galaxie-Sterne-Planeten-Milchstrasse-Universum",
    "weltall": "05_Weltall-Galaxie-Sterne-Planeten-Milchstrasse-Universum",
    "03-makro-natur": "04_Macro-Naturmakro-Miniatur-Nahaufnahmen",
    "makro": "04_Macro-Naturmakro-Miniatur-Nahaufnahmen",
    "04-industrial": "08_Industrial-Beton-Urban-LostPlaces",
    "industrial": "08_Industrial-Beton-Urban-LostPlaces",
    "09-mikrochips": "08_Industrial-Beton-Urban-LostPlaces",
    "mikrochips": "08_Industrial-Beton-Urban-LostPlaces",
    "10-western": "08_Industrial-Beton-Urban-LostPlaces",
    "western": "08_Industrial-Beton-Urban-LostPlaces",
    "05-surreal": "03_Surreal-Abstrakt-Fraktale-Designs",
    "surreal": "03_Surreal-Abstrakt-Fraktale-Designs",
    "06-horror": "18_Teufel-Geister-Daemonen-Inferno",
    "horror": "18_Teufel-Geister-Daemonen-Inferno",
    "07-akt": "06_Sexy-Frauen-Akt-Dessous-Romantik",
    "akt": "06_Sexy-Frauen-Akt-Dessous-Romantik",
    "08-pixelart": "14_8bit-Retro-Games-Arcade",
    "pixelart": "14_8bit-Retro-Games-Arcade",
    "11-mittelalter": "19_Moenche-Kloster-Orden",
    "mittelalter": "19_Moenche-Kloster-Orden",
    "12-ancient-cultures": "19_Moenche-Kloster-Orden",
    "ancient": "19_Moenche-Kloster-Orden",
    "13-fantasy": "07_Fantasy-Tolkien-Drachen-Dinos-Hexen-Hochkulturen",
    "fantasy": "07_Fantasy-Tolkien-Drachen-Dinos-Hexen-Hochkulturen",
    "14-zitate": "10_Motivation-Sprueche-Zitate-Inspiration",
    "zitate": "10_Motivation-Sprueche-Zitate-Inspiration",
}


def theme_for(rel: str) -> str:
    """Thema aus Ordner (Bilder) bzw. Dateinamen-Präfix (Wurzelvideos)."""
    parts = rel.split(os.sep)
    key = parts[0] if len(parts) > 1 else os.path.splitext(parts[0])[0]
    if key in THEME_BY_KEY:
        return THEME_BY_KEY[key]
    stem = os.path.splitext(parts[-1])[0].lower()
    for token, cat in THEME_BY_KEY.items():
        if stem.startswith(token):
            return cat
    return ""


def cid_for(rel: str) -> str:
    return "n" + hashlib.sha1(rel.encode("utf-8")).hexdigest()[:6]


def probe(path: str) -> Dict[str, float]:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
            capture_output=True, text=True, timeout=30,
        )
        j = json.loads(r.stdout or "{}")
        st = (j.get("streams") or [{}])[0]
        return {"w": int(st.get("width") or 0), "h": int(st.get("height") or 0),
                "dur": float((j.get("format") or {}).get("duration") or 0)}
    except Exception:
        return {"w": 0, "h": 0, "dur": 0}


def main() -> None:
    plan = json.load(open(PLAN, encoding="utf-8"))
    have = {i["cid"] for i in plan}
    new: List[dict] = []
    skipped_theme = 0

    for dp, dn, fn in os.walk(SRC):
        dn.sort()
        for f in sorted(fn):
            ext = os.path.splitext(f)[1].lower()
            if ext not in IMG_EXT | VID_EXT:
                continue
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, SRC)
            root_image = os.sep not in rel and ext in IMG_EXT
            if root_image:
                continue  # Wurzelbilder sind in Stufe 3 abgearbeitet
            theme = theme_for(rel)
            if not theme:
                skipped_theme += 1
                continue
            cid = cid_for(rel)
            if cid in have:
                continue
            mood, energy, short, nice = imp.CATEGORY_STYLE[theme]
            kind = "video" if ext in VID_EXT else "image"
            info = probe(full) if kind == "video" else {"w": 0, "h": 0, "dur": 0}
            if kind == "video" and info["dur"] < 1.5:
                continue
            seg = min(imp.CLIP_SECONDS, max(2.0, info["dur"])) if kind == "video" else imp.CLIP_SECONDS
            start = 0.0 if info["dur"] <= imp.CLIP_SECONDS * 2 else round(info["dur"] * 0.15, 2)
            new.append({
                "cid": cid, "cat": theme, "kind": kind, "path": full,
                "label": f"{nice} {os.path.splitext(f)[0][:14]}",
                "tags": [short, "eigenmaterial", os.path.splitext(f)[0].split("-")[0]],
                "license": "Eigenmaterial (privat)", "attribution": "Patrick (eigenes Material)",
                "source_url": "", "source": "wd-visuals-themen",
                "title": f"Eigenmotiv {rel}",
                "mood": mood, "energy": energy, "seconds": seg,
                "width": info["w"], "height": info["h"], "start": start,
                "rendered": {}, "uploaded": {},
            })

    plan.extend(new)
    with open(PLAN, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, ensure_ascii=False, indent=1)
    from collections import Counter
    print(f"angehängt: {len(new)} Clips (gesamt {len(plan)}), ohne Thema übersprungen: {skipped_theme}")
    print('Art:', dict(Counter(i['kind'] for i in new)))
    print(Counter(i['cat'][:30] for i in new).most_common())


if __name__ == "__main__":
    main()
