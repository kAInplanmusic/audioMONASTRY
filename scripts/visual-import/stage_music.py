#!/usr/bin/env python3
"""Sammelt DJ-Tracks (<100 MB) von der BRAIN-Platte in einen Staging-Baum und
lädt sie über `upload-samples-batch.py` nach R2 (`samples/music/<artist>/`).

Warum Staging: die Titel liegen wild verteilt (Techno/, Unsortiert/,
_nachzutragen/, Projektordner). `upload-samples-batch.py` erwartet einen Baum
mit genau einer Ebene als "Pack". Hier wird deshalb pro Artist ein Ordner
angelegt, Dateien werden **hart verlinkt** (kein zusätzlicher Plattenplatz) und
über SHA-256 dedupliziert (derselbe Track liegt oft in zwei Ordnern).

Aufruf:
    python3 scripts/visual-import/stage_music.py            # nur sammeln + Bericht
    python3 scripts/visual-import/stage_music.py --upload    # sammeln + hochladen
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata
from typing import Dict, List, Tuple

REPO = "/mnt/wd-elements/Medien/Projekte/audioMONASTRY"
STAGE = "/mnt/wd-elements/_stage-music"
MANIFEST = os.path.join(REPO, "data", "r2-pakete", "music-stage.json")
MAX_MB = 100

#: Suchbegriff im Pfad/Dateinamen (normalisiert) -> Zielordner
ARTISTS: List[Tuple[str, str]] = [
    ("tommy four seven", "tommy-four-seven"),
    ("monika krus", "monika-kruse"),
    ("monika kris", "monika-kruse"),
    ("klaudia gawlas", "klaudia-gawlas"),
    ("mike wall", "mike-wall"),
    ("hackler", "hackler-kuch"),
    ("kuch", "hackler-kuch"),
    ("chris liebing", "chris-liebing"),
    ("format b", "format-b"),
    ("sven vaeth", "sven-vaeth"),
    ("sven v", "sven-vaeth"),
    ("brian", "brian"),
]
AUDIO = {".mp3", ".flac", ".wav", ".aiff", ".aif", ".m4a", ".ogg", ".opus"}
ROOTS = ["/mnt/wd-elements/Musik", "/mnt/wd-elements/Medien/iCloud-Musik", "/home/patrick/Musik"]


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s)


def safe(name: str, used: set) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "track"
    stem, ext = os.path.splitext(base)
    cand = base
    n = 2
    while cand.lower() in used:
        cand = f"{stem}-{n}{ext}"
        n += 1
    used.add(cand.lower())
    return cand


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--upload", action="store_true")
    a = ap.parse_args()

    seen: Dict[str, str] = {}
    taken: Dict[str, set] = {}
    rows = []
    for root in ROOTS:
        if not os.path.isdir(root):
            continue
        for dp, dn, fn in os.walk(root):
            dn[:] = [d for d in dn if not d.startswith(".")]
            nd = norm(dp)
            for f in fn:
                if os.path.splitext(f)[1].lower() not in AUDIO:
                    continue
                text = f"{norm(f)} {nd}"
                artist = next((slug for term, slug in ARTISTS if term in text), "")
                if not artist:
                    continue
                src = os.path.join(dp, f)
                size = os.path.getsize(src)
                if size > MAX_MB * 1024 * 1024:
                    continue
                digest = sha256(src)
                if digest in seen:
                    continue
                seen[digest] = src
                dst_dir = os.path.join(STAGE, artist)
                os.makedirs(dst_dir, exist_ok=True)
                used = taken.setdefault(artist, set())
                dst = os.path.join(dst_dir, safe(f, used))
                if not os.path.exists(dst):
                    try:
                        os.link(src, dst)
                    except OSError:
                        subprocess.run(["cp", "--reflink=auto", src, dst], check=False)
                rows.append({"artist": artist, "file": os.path.basename(dst), "src": src,
                             "bytes": size, "sha256": digest})

    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    json.dump(rows, open(MANIFEST, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    counts: Dict[str, int] = {}
    for r in rows:
        counts[r["artist"]] = counts.get(r["artist"], 0) + 1
    print(f"gesammelt: {len(rows)} Titel, {sum(r['bytes'] for r in rows)/1e9:.2f} GB -> {STAGE}")
    for k in sorted(counts):
        print(f"  {k:18} {counts[k]:4}")

    if not a.upload:
        print("(Trockenlauf — mit --upload nach R2)")
        return
    cmd = [
        sys.executable, os.path.join(REPO, "scripts", "upload-samples-batch.py"),
        "--root", STAGE, "--prefix", "samples/music/", "--max-mb", str(MAX_MB), "--yes",
    ]
    print("starte:", " ".join(cmd))
    raise SystemExit(subprocess.run(cmd, cwd=REPO).returncode)


if __name__ == "__main__":
    main()
