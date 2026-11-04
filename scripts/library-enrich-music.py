#!/usr/bin/env python3
"""Musikbibliothek anreichern: Tempo, Tonart, Dauer nachtragen.

WARUM: `music_tracks` traegt bei den alten Zeilen oft nur Name/Artist/URL.
Fuer eine DJ-Bibliothek fehlen Tempo und Tonart. Dieses Skript misst sie an der
Datei (lokal, sonst per Download aus der oeffentlichen R2-URL) und schreibt nur
die Felder zurueck, die leer sind oder sich messbar verbessern:
`bpm`, `key`, `duration_seconds`. Vorhandene Werte werden nicht ueberschrieben.

Die Lautheit wird NICHT gemessen - `music_tracks` hat dafuer keine Spalte
(anders als `samples.lufs`); das spart pro Titel den vollen zweiten Decode.

Aufruf:
    python3 scripts/library-enrich-music.py                  # Trockenlauf
    python3 scripts/library-enrich-music.py --yes            # schreiben
    python3 scripts/library-enrich-music.py --only-bpm --yes # nur Tempo nachtragen
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional, Tuple

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
from audio_meta import analyze  # noqa: E402


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


def local_index() -> Dict[str, str]:
    """Dateiname -> lokaler Pfad (public/music + Upload-Manifeste)."""
    index: Dict[str, str] = {}
    pub = REPO / "public/music"
    if pub.is_dir():
        for f in pub.iterdir():
            if f.is_file():
                index.setdefault(f.name, str(f))
    for man in sorted((REPO / "data/r2-pakete").glob("musik-paket-*.json")):
        try:
            data = json.loads(man.read_text())
        except json.JSONDecodeError:
            continue
        for entry in data.get("titel") or []:
            base = os.path.basename(str(entry.get("quelle", "")))
            if base and base not in index and os.path.isfile(str(entry["quelle"])):
                index[base] = str(entry["quelle"])
    return index


def fetch_rows(base: str, anon: str) -> List[Dict]:
    req = urllib.request.Request(
        f"{base}/rest/v1/music_tracks?select=id,name,artist,url,bpm,key,duration_seconds&limit=2000",
        headers={"apikey": anon, "Authorization": f"Bearer {anon}"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def resolve(row: Dict, index: Dict[str, str], cache: pathlib.Path) -> Optional[str]:
    """Lokale Datei zum Datensatz: id-basierter Name, sonst Download aus der URL."""
    rid = str(row["id"])
    name = rid.split("/")[-1]
    if rid.startswith("/music/"):
        name = rid[len("/music/"):]
    if name in index:
        return index[name]
    url = str(row.get("url") or "")
    if not url.startswith("http"):
        return None
    target = cache / urllib.parse.quote(os.path.basename(url), safe="")
    if target.exists() and target.stat().st_size > 0:
        return str(target)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) audiomonastry-enrich/1.0"})
        with urllib.request.urlopen(req, timeout=180) as resp, open(target, "wb") as fh:
            fh.write(resp.read())
        return str(target)
    except Exception:  # noqa: BLE001 - Download darf den Lauf nicht stoppen
        return None


def patch(base: str, key: str, row_id: str, values: Dict) -> None:
    q = urllib.parse.quote(row_id, safe="")
    req = urllib.request.Request(
        f"{base}/rest/v1/music_tracks?id=eq.{q}",
        data=json.dumps(values).encode(),
        method="PATCH",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"PATCH {resp.status}")


def main() -> int:
    ap = argparse.ArgumentParser(description="music_tracks um bpm/key/duration ergaenzen")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    env = read_env(".env", ".env.deploy")
    base = (env.get("VITE_SUPABASE_URL") or "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    anon = env.get("VITE_SUPABASE_ANON_PUB") or ""
    if not base or not key or not anon:
        print("Fehlt in .env: VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ANON", file=sys.stderr)
        return 2

    rows = fetch_rows(base, anon)
    if args.limit:
        rows = rows[:args.limit]
    index = local_index()
    cache = pathlib.Path(tempfile.mkdtemp(prefix="am-music-enrich-"))
    print(f"Zeilen: {len(rows)}  |  lokal zuordenbar: {sum(1 for r in rows if (r['id'].split('/')[-1] in index))}  |  Cache: {cache}")

    updates: List[Tuple[Dict, Dict]] = []
    missing = 0

    def work(row: Dict):
        path = resolve(row, index, cache)
        if not path:
            return None
        meta = analyze(path, loudness=False)  # music_tracks hat keine lufs-Spalte
        values: Dict = {}
        if not row.get("bpm") and meta.get("bpm"):
            # music_tracks.bpm ist INTEGER (samples.bpm ist numeric) - runden.
            values["bpm"] = int(round(float(meta["bpm"])))
        if not row.get("key") and meta.get("key"):
            values["key"] = meta["key"]
        if not row.get("duration_seconds") and meta.get("duration_seconds"):
            values["duration_seconds"] = meta["duration_seconds"]
        return (row, values) if values else (row, {})

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, res in enumerate(pool.map(work, rows), 1):
            if res is None:
                missing += 1
            elif res[1]:
                updates.append(res)
            if i % 20 == 0 or i == len(rows):
                print(f"\r  geprueft: {i}/{len(rows)} | Aenderungen: {len(updates)} | ohne Quelle: {missing}", end="", flush=True)
    print()

    for row, values in updates[:5]:
        print(f"  {str(row['name'])[:40]:42} {row.get('bpm') or '-':>6} -> {values.get('bpm', '-'):<6} "
              f"{row.get('key') or '-':7} -> {values.get('key', '-'):7}")
    if not args.yes:
        print(f"\nTrockenlauf: {len(updates)} Zeilen wuerden geaendert. Mit --yes ausfuehren.")
        return 0

    errors = 0
    for i, (row, values) in enumerate(updates, 1):
        try:
            patch(base, key, str(row["id"]), values)
        except Exception as exc:  # noqa: BLE001
            errors += 1
            if errors <= 3:
                print("  !", row["id"], exc)
        if i % 25 == 0 or i == len(updates):
            print(f"\r  geschrieben: {i}/{len(updates)} ({errors} Fehler)", end="", flush=True)
    print()
    print(f"fertig: {len(updates)} Zeilen aktualisiert, {errors} Fehler, {missing} ohne Quelle")
    return 4 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
