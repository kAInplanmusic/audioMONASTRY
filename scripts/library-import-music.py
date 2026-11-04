#!/usr/bin/env python3
"""R2-Musikpaket in die Bibliothek eintragen (`music_tracks`).

WARUM: `scripts/upload-music-batch.py` legt nur die Audio-Objekte nach R2.
Sichtbar werden sie erst mit einer Zeile in `public.music_tracks`
(`url = <CFR2_PUBLIC_URL>/music/<key>`); die Tabelle ist per RLS ausschliesslich
fuer `service_role` beschreibbar (`service_write_music`, database/schema.sql).
Dieses Skript liest das Upload-Manifest, holt Titel/Interpret/Genre/Dauer per
ffprobe aus den Originaldateien und schreibt die Zeilen idempotent
(upsert auf `id`).

Aufruf:
    python3 scripts/library-import-music.py                 # Trockenlauf
    python3 scripts/library-import-music.py --yes           # schreiben
    python3 scripts/library-import-music.py --manifest data/r2-pakete/musik-paket-....json --yes

Voraussetzung: SUPABASE_SERVICE_ROLE_KEY + VITE_SUPABASE_URL in der `.env`
(der anon-Key darf nur lesen). Der Key wird nie ausgegeben.

Exit: 0 ok · 2 Konfiguration · 4 Schreibfehler.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.parse
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

REPO = pathlib.Path(__file__).resolve().parent.parent


def read_env(*files: str) -> Dict[str, str]:
    env: Dict[str, str] = {}
    for name in files:
        p = REPO / name
        if not p.exists():
            continue
        for line in p.read_text(errors="ignore").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, _, v = s.partition("=")
            env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def ffprobe(path: str) -> Dict[str, str]:
    """Titel/Interpret/Genre/Dauer aus der Datei (best effort, nie hart scheitern)."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries",
             "format=duration:format_tags=title,artist,genre", "-of", "json", path],
            capture_output=True, text=True, timeout=20,
        )
        data = json.loads(out.stdout or "{}")
        fmt = data.get("format", {})
        tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
        return {
            "title": (tags.get("title") or "").strip(),
            "artist": (tags.get("artist") or "").strip(),
            "genre": (tags.get("genre") or "").strip(),
            "duration": fmt.get("duration") or "",
        }
    except Exception:  # noqa: BLE001 - Metadaten sind optional
        return {"title": "", "artist": "", "genre": "", "duration": ""}


def clean_name(stem: str) -> str:
    s = re.sub(r"^\d{1,3}\s*[-._ ]+\s*", "", stem)
    s = s.replace("_", " ").replace("&", "&")
    return re.sub(r"\s{2,}", " ", s).strip(" -_")


def build_rows(manifest: Dict, public_base: str) -> List[Dict]:
    entries = manifest.get("titel") or manifest.get("dateien") or []
    rows: List[Dict] = []
    seen_ids = set()

    def meta(entry):
        return entry, ffprobe(str(entry["quelle"]))

    with ThreadPoolExecutor(max_workers=8) as pool:
        enriched = list(pool.map(meta, entries))

    for entry, m in enriched:
        quelle = str(entry["quelle"])
        stem = os.path.splitext(os.path.basename(quelle))[0]
        base_id = "/music/" + os.path.basename(quelle)
        row_id = base_id
        n = 2
        while row_id in seen_ids:  # gleiche Dateinamen aus zwei Ordnern
            row_id = f"{base_id}#{n}"
            n += 1
        seen_ids.add(row_id)

        name = m["title"] or clean_name(stem)
        artist = m["artist"]
        if not artist and " - " in name:
            artist = name.split(" - ", 1)[0].strip()
        duration = None
        try:
            duration = round(float(m["duration"]), 3) if m["duration"] else None
        except ValueError:
            duration = None

        rows.append({
            "id": row_id,
            "name": name,
            "artist": artist or None,
            "url": public_base.rstrip("/") + "/" + entry["key"],
            "style": m["genre"] or "Electro",
            "duration_seconds": duration,
            "tags": ["r2-paket", "elektro"],
        })
    return rows


def post_rows(base: str, key: str, rows: List[Dict]) -> None:
    """Upsert in Bloecken von 50 (PostgREST, on_conflict=id)."""
    for i in range(0, len(rows), 50):
        chunk = rows[i:i + 50]
        req = urllib.request.Request(
            f"{base}/rest/v1/music_tracks?on_conflict=id",
            data=json.dumps(chunk).encode(),
            method="POST",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                if resp.status >= 300:
                    raise RuntimeError(f"PostgREST {resp.status}: {resp.read()[:300]!r}")
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"PostgREST {exc.code}: {exc.read().decode(errors='replace')[:400]}") from None
        print(f"  geschrieben: {min(i + 50, len(rows))}/{len(rows)}")


def main() -> int:
    ap = argparse.ArgumentParser(description="R2-Musiktitel in music_tracks eintragen")
    ap.add_argument("--manifest", help="Manifest-JSON (Default: neuestes musik-paket-*.json)")
    ap.add_argument("--yes", action="store_true", help="wirklich schreiben")
    args = ap.parse_args()

    env = read_env(".env", ".env.deploy")
    base = (env.get("VITE_SUPABASE_URL") or "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    public = (env.get("CFR2_PUBLIC_URL") or env.get("CFS3_PUBLIC_URL") or "").rstrip("/")
    if not base or not key:
        print("Fehlt: VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env", file=sys.stderr)
        return 2
    if not public:
        print("Fehlt: CFR2_PUBLIC_URL in .env", file=sys.stderr)
        return 2

    mpath = args.manifest
    if not mpath:
        found = sorted((REPO / "data/r2-pakete").glob("musik-paket-*.json"))
        if not found:
            print("Kein Manifest gefunden (data/r2-pakete/musik-paket-*.json)", file=sys.stderr)
            return 2
        mpath = str(found[-1])
    manifest = json.loads(pathlib.Path(mpath).read_text())
    rows = build_rows(manifest, public)
    print(f"Manifest: {mpath}")
    print(f"Zeilen: {len(rows)}  ->  {base}/rest/v1/music_tracks")
    for r in rows[:5]:
        print(f"  {r['name'][:50]:52} | {str(r['artist'])[:28]:30} | {r['duration_seconds']}s")
    if len(rows) > 5:
        print(f"  ... {len(rows)-5} weitere")
    if not args.yes:
        print("\nTrockenlauf - nichts geschrieben. Mit --yes ausfuehren.")
        return 0
    post_rows(base, key, rows)
    print(f"fertig: {len(rows)} Zeilen upgesertet")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
