#!/usr/bin/env python3
"""Gleicht die R2-Indizes (`bank-index.json`, `varianten-index.json`) mit dem
Import-Plan ab und entfernt Clips, die nicht weiterverbreitet werden dürfen.

Hintergrund: `import_monastry.py upload` schreibt die Indizes **am Ende** eines
Laufs. Bricht der Lauf vorher ab, bleibt der Bestand inkonsistent (Index 122,
Dateien 175). Dieses Skript ist die Reparatur- und Prüfstufe: es leitet den
Index aus dem Plan ab (der Plan ist die Wahrheit über das, was hochgeladen
wurde) und lässt die alten `b*`-Einträge unangetastet.

Aufruf:
    python3 scripts/visual-import/reconcile_bank.py [--drop-license-blocked] [--dry-run]

`--drop-license-blocked` entfernt Clips mit Lizenzen, die eine öffentliche
Weiterverbreitung verbieten (Coverr/Unsplash/Mixkit) — samt Dateien auf R2.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List

REPO = "/mnt/wd-elements/Medien/Projekte/audioMONASTRY"
PLAN = os.path.join(REPO, ".visual-import", "plan.json")

#: Lizenzen ohne Weiterverbreitungsrecht (öffentliche Bank = Weiterverbreitung).
NOT_REDISTRIBUTABLE = ("coverr license", "unsplash license", "mixkit free license")


def load_r2():
    sys.path.insert(0, os.path.join(REPO, "scripts"))
    env = os.path.join(REPO, ".env")
    if os.path.exists(env):
        for line in open(env, "r", encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    import s3lite
    return s3lite.S3Target.from_r2_env()


def public_url(key: str) -> str:
    base = os.environ.get("CFR2_PUBLIC_URL", "https://pub-663ece9f219d4704b826b80715e82034.r2.dev").rstrip("/")
    return f"{base}/{key}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--drop-license-blocked", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    t = load_r2()
    plan: List[Dict] = json.load(open(PLAN, encoding="utf-8"))

    dropped: List[str] = []
    if a.drop_license_blocked:
        keep = []
        for it in plan:
            lic = (it.get("license") or "").lower()
            if any(x in lic for x in NOT_REDISTRIBUTABLE):
                dropped.append(it["cid"])
                continue
            keep.append(it)
        plan = keep
        for cid in dropped:
            keys = [f"visuals/bank/{cid}.mp4", f"visuals/bank/{cid}_start.jpg"]
            keys += [f"visuals/bank/{cid}_{v}.mp4" for v in it_variants()]
            for k in keys:
                if a.dry_run:
                    continue
                t._request("DELETE", k)  # noqa: SLF001 — s3lite liefert kein delete()
        if not a.dry_run:
            json.dump(plan, open(PLAN, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"lizenzwidrig entfernt: {len(dropped)} {dropped}")

    bank = json.loads(t.get_bytes("visuals/bank/bank-index.json") or b"{}")
    vidx = json.loads(t.get_bytes("visuals/bank/varianten-index.json") or b"{}")

    added = updated = 0
    for it in plan:
        if not it.get("uploaded"):
            continue
        cid = it["cid"]
        keys = it["uploaded"]
        entry = {
            "name": cid,
            "datei": f"{cid}.mp4",
            "laenge": 1,
            "prompt_art": (it.get("tags") or ["import"])[0],
            "prompt": it.get("title", ""),
            "motiv": it.get("title", ""),
            "quelle": it.get("path", ""),
            "bytes": os.path.getsize(it["rendered"]["base"]) if it.get("rendered", {}).get("base") else 0,
            "sekunden": it.get("seconds", 6),
            "url": public_url(keys["base"]),
            "imported": True,
            "kategorie": it["cat"],
            "mood": it["mood"],
            "energy": it["energy"],
            "tags": it.get("tags", []),
            "license": it.get("license", ""),
            "attribution": it.get("attribution", ""),
            "source_url": it.get("source_url", ""),
            "source": it.get("source", ""),
            "start": public_url(f"visuals/bank/{cid}_start.jpg"),
            "varianten": {n: public_url(k) for n, k in keys.items() if n not in ("base", "start.jpg")},
        }
        if cid in bank:
            updated += 1
        else:
            added += 1
        bank[cid] = entry
        vidx[cid] = {
            "quelle": f"{cid}.mp4",
            "varianten": {n: {"url": public_url(k)} for n, k in keys.items() if n not in ("base", "start.jpg")},
        }
    for cid in dropped:
        bank.pop(cid, None)
        vidx.pop(cid, None)

    print(f"Index: {len(bank)} Einträge ({added} neu, {updated} aktualisiert), Varianten: {len(vidx)}")
    if a.dry_run:
        print("dry-run: nichts geschrieben")
        return
    t.put_bytes("visuals/bank/bank-index.json", json.dumps(bank, ensure_ascii=False, indent=1).encode(), "application/json")
    t.put_bytes("visuals/bank/varianten-index.json", json.dumps(vidx, ensure_ascii=False, indent=1).encode(), "application/json")
    print("Index auf R2 geschrieben")


def it_variants() -> List[str]:
    return ["loop", "quadrat", "wide", "slow", "fast", "mirror", "hue15", "grau"]


if __name__ == "__main__":
    main()
