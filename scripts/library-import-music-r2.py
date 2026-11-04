#!/usr/bin/env python3
"""Trägt die R2-Musik aus `samples/music/` in `public.music_tracks` ein (biblioMONK).

`upload-samples-batch.py` legt nur die Objekte ab; sichtbar in biblioMONK werden
sie erst mit einer Zeile in `music_tracks`. Quelle ist der Staging-Baum
(`/mnt/wd-elements/_stage-music/<artist>/<datei>`), der exakt dem Upload-Praefix
`samples/music/<artist>/` entspricht.

Schema der Zeile: id, name, artist, url, bpm, style, tags, key, duration_seconds.
`url` zeigt auf die same-origin Route (`/api/media/r2/...`), damit biblioMONK auch
bei privatem Bucket laedt (`Tone.ToneAudioBuffer(url)`).

Aufruf:
    python3 scripts/library-import-music-r2.py            # Trockenlauf
    python3 scripts/library-import-music-r2.py --yes      # schreiben
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List

REPO = "/mnt/wd-elements/Medien/Projekte/audioMONASTRY"
STAGE = "/mnt/wd-elements/_stage-music"
PREFIX = "samples/music/"
AUDIO = {".mp3", ".flac", ".wav", ".aiff", ".aif", ".m4a", ".ogg", ".opus"}


def env() -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in open(os.path.join(REPO, ".env"), encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return out


def probe(path: str) -> float:
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", path], capture_output=True, text=True, timeout=30)
        return round(float(r.stdout.strip() or 0), 2)
    except Exception:
        return 0.0


def artist_from(slug: str) -> str:
    return " ".join(w.capitalize() for w in slug.split("-"))


def clean_name(stem: str) -> str:
    s = re.sub(r"^\d{1,3}[-_. ]+", "", stem)
    s = s.replace("_", " ")
    s = re.sub(r"\s{2,}", " ", s).strip()
    return s[:120] or stem[:120]


def rows() -> List[dict]:
    out: List[dict] = []
    if not os.path.isdir(STAGE):
        sys.exit(f"Staging fehlt: {STAGE}")
    for artist in sorted(os.listdir(STAGE)):
        d = os.path.join(STAGE, artist)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if os.path.splitext(f)[1].lower() not in AUDIO:
                continue
            path = os.path.join(d, f)
            key = f"{PREFIX}{artist}/{f}"
            stem = os.path.splitext(f)[0]
            out.append({
                "id": key,
                "name": clean_name(stem),
                "artist": artist_from(artist),
                "url": "/api/media/r2/" + "/".join(
                    urllib.parse.quote(seg, safe="") for seg in key.split("/")),
                "bpm": None,
                "style": "Techno" if "liebing" in artist or "sven" in artist else None,
                "key": None,
                "duration_seconds": probe(path),
            })
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true")
    a = ap.parse_args()

    data = rows()
    print(f"gefunden: {len(data)} Tracks in {STAGE}")
    if not data:
        return
    e = env()
    url = (e.get("VITE_SUPABASE_URL") or e.get("VITE_SB_URL") or "").rstrip("/")
    key = e.get("SUPABASE_SERVICE_ROLE_KEY") or e.get("SB_SERVICE_ROLE") or ""
    if not (url and key):
        sys.exit("Supabase nicht konfiguriert (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)")
    if not a.yes:
        print("Trockenlauf — Beispiele:")
        for r in data[:3]:
            print(" ", r["id"], "|", r["artist"], "|", r["name"][:40], "|", r["duration_seconds"], "s")
        print("(mit --yes schreiben)")
        return

    def put(row: dict) -> bool:
        body = json.dumps(row).encode()
        req = urllib.request.Request(
            f"{url}/rest/v1/music_tracks?on_conflict=id", data=body, method="POST",
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status in (200, 201, 204)
        except urllib.error.HTTPError as exc:
            print("  Fehler", row["id"][:60], exc.code, exc.read().decode()[:120])
            return False

    with ThreadPoolExecutor(max_workers=8) as ex:
        ok = list(ex.map(put, data))
    print(f"music_tracks: {sum(1 for x in ok if x)}/{len(data)} geschrieben")


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (wird in rows() gebraucht)
    main()
