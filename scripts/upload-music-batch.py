#!/usr/bin/env python3
"""Musik-Paket nach R2 legen: N Lieder aus den elektronischen Archiven.

WARUM: Die App liest `/music/<datei>` aus dem Bucket (`scripts/upload-library-music.mjs`,
gleiche Schluesselregel wie `safeName` in `server/routes/uploadRoutes.ts`). Bisher wurden
nur die 45 Demo-Titel aus `public/music` hochgeladen (plus wenige Einzelstuecke). Dieses
Skript legt weitere Lieder direkt aus den Musik-Archiven ab - inhaltsfern, idempotent und
ohne die schweren Originale ins Repo zu kopieren.

Schluessel: `music/<sicher-name>.<endung>` - klein, alles Nicht-Alphanumerische wird zu '-'
(identisch zur Server-Regel; NICHT transliterieren, sonst laufen App-Pfad und Objekt
auseinander).

Auswahl (deterministisch, damit ein zweiter Lauf dieselben Dateien sieht):
  * nur Audio-Endungen .mp3/.flac,
  * Groesse zwischen --min-mb und --max-mb (Standard 1..20 MB - keine Riesen-Dateien),
  * Dateiname (normalisiert) noch nicht im Bucket, innerhalb des Laufs eindeutig,
  * Sortierung nach (Ordner, Name), dann die ersten --limit.

Aufruf:
    python3 scripts/upload-music-batch.py                    # Trockenlauf: Auswahl + Volumen
    python3 scripts/upload-music-batch.py --yes --limit 100  # hochladen
    python3 scripts/upload-music-batch.py --yes --only /tmp/liste.txt   # feste Liste
    python3 scripts/upload-music-batch.py --manifest data/r2-pakete      # Manifest-Ziel

Exit: 0 ok · 2 Konfiguration · 4 Fehler bei Dateien.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import struct
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
import s3lite  # noqa: E402

DEFAULT_ROOTS = [
    "/mnt/wd-elements/Musik/Electro",
    "/mnt/wd-elements/Musik/Electronica",
    "/mnt/wd-elements/Musik/Elektronisch",
    "/mnt/wd-elements/Musik/Dance",
]
AUDIO_EXT = {".mp3": "audio/mpeg", ".flac": "audio/flac"}
BUCKET_PREFIX = "music/"


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


def safe_name(stem: str) -> str:
    """Wie `safeName` im Server: lowercase, Nicht-Alphanumerisches -> '-'."""
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")


def key_stem(filename_stem: str) -> str:
    """Fuehrende Track-Nummern entfernen ("01 - Orphx - Lost Again" -> "Orphx - Lost Again").

    Die vorhandenen Schluessel unter music/ tragen keine Nummern; ohne diese
    Bereinigung hiesse jedes Lied eines Albums "01-...", "02-..." und der
    Bibliothekseintrag waere nicht mehr am Titel zu erkennen.
    """
    return safe_name(re.sub(r"^\d{1,3}\s*[-._ ]+\s*", "", filename_stem))


GENRE_DEFAULT = r"electro|techno|techn?house|house|trance|dance|minimal|electronic|schranz|hardstyle|jump"
#: DJ-Mixe, Megamixe und Sammelordner ohne Einzeltitel - als "Lied" unbrauchbar.
EXCLUDE_DEFAULT = r"megamix|2 many dj|radio soulwax|mixed by|mix \d{2}\.\d{4}|best of alex|gemischt|tecktonik|jumpstyle|vocal house charts"
#: Ordner, die zuerst durchsucht werden (echte Elektronik-Alben/-Sampler).
PREFER_DEFAULT = r"techno|minimal|techhouse|house|electro|electronik|trance|liebing|rother|kalkbrenner|bodzin|booka shade"


def _id3_text(raw: bytes) -> str:
    """TCON-Frame-Text dekodieren (ID3v2.3/2.4: Latin-1, UTF-16 mit/ohne BOM, UTF-8)."""
    if not raw:
        return ""
    enc, body = raw[0], raw[1:]
    try:
        if enc == 0:
            text = body.decode("latin-1", "ignore")
        elif enc == 1:
            text = body.decode("utf-16", "ignore")
        elif enc == 2:
            text = body.decode("utf-16-be", "ignore")
        else:
            text = body.decode("utf-8", "ignore")
    except Exception:  # noqa: BLE001 - kaputte Tags duerfen die Auswahl nicht stoppen
        return ""
    return text.replace("\x00", " ").strip()


def genre_of(path: str) -> str:
    """Genre aus dem ID3v2-Tag lesen (nur die ersten 512 KB; kein mutagen noetig)."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(512 * 1024)
    except OSError:
        return ""
    if len(head) < 10 or head[:3] != b"ID3":
        return ""
    ver = head[3]
    tag_size = ((head[6] & 0x7F) << 21) | ((head[7] & 0x7F) << 14) | ((head[8] & 0x7F) << 7) | (head[9] & 0x7F)
    body = head[10:10 + tag_size]
    pos = 0
    while pos + 10 <= len(body):
        fid = body[pos:pos + 4]
        if not fid.strip(b"\x00"):
            break
        size = struct.unpack(">I", body[pos + 4:pos + 8])[0]
        if ver == 4:  # ID3v2.4: synchsafe
            size = ((size >> 24) & 0x7F) << 21 | ((size >> 16) & 0x7F) << 14 | ((size >> 8) & 0x7F) << 7 | (size & 0x7F)
        if size <= 0 or pos + 10 + size > len(body):
            break
        if fid == b"TCON":
            return _id3_text(body[pos + 10:pos + 10 + size])
        pos += 10 + size
    return ""


def collect(roots: List[str], min_mb: float, max_mb: float, genre_re: Optional[re.Pattern],
            folder_fallback: bool) -> List[Tuple[str, int, str, str, str]]:
    """(pfad, groesse, key, genre, ordner) fuer alle passenden Audiodateien."""
    out: List[Tuple[str, int, str, str, str]] = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for fname in sorted(filenames):
                ext = os.path.splitext(fname)[1].lower()
                if ext not in AUDIO_EXT:
                    continue
                path = os.path.join(dirpath, fname)
                try:
                    size = os.path.getsize(path)
                except OSError:
                    continue
                if not (min_mb * 2**20 <= size <= max_mb * 2**20):
                    continue
                genre = genre_of(path)
                if genre_re is not None:
                    hay = genre or (os.path.basename(dirpath) if folder_fallback else "")
                    if not genre_re.search(hay.lower()):
                        continue
                key = BUCKET_PREFIX + key_stem(os.path.splitext(fname)[0]) + ext
                out.append((path, size, key, genre, os.path.basename(dirpath)))
    return out


def list_existing_keys(target: s3lite.S3Target) -> set:
    """Alle Schluessel unter music/ (ListObjectsV2, seitenweise)."""
    keys: set = set()
    token = ""
    while True:
        q = {"list-type": "2", "prefix": BUCKET_PREFIX, "max-keys": "1000"}
        if token:
            q["continuation-token"] = token
        status, _, body = target._request("GET", "", query=q)
        if status >= 300:
            raise SystemExit(f"LIST {BUCKET_PREFIX}: HTTP {status}")
        import xml.etree.ElementTree as ET

        root = ET.fromstring(body)
        ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
        for el in root.findall(".//s3:Contents/s3:Key", ns) or root.findall(".//Contents/Key"):
            keys.add(el.text or "")
        truncated = (root.findtext(".//s3:IsTruncated", "", ns) or root.findtext(".//IsTruncated", "") or "").lower()
        if truncated != "true":
            break
        token = (
            root.findtext(".//s3:NextContinuationToken", "", ns)
            or root.findtext(".//NextContinuationToken", "")
            or ""
        )
        if not token:
            break
    return keys


def main() -> int:
    ap = argparse.ArgumentParser(description="Elektronische Lieder nach R2 music/ legen")
    ap.add_argument("--roots", nargs="*", default=DEFAULT_ROOTS)
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--min-mb", type=float, default=1.0)
    ap.add_argument("--genre", default=GENRE_DEFAULT,
                    help="Genre-Filter (Regex auf das ID3-TCON; '' = aus). Standard: elektronische Genres")
    ap.add_argument("--no-folder-fallback", action="store_true",
                    help="Dateien ohne Genre-Tag nicht ueber den Ordnernamen einordnen")
    ap.add_argument("--exclude", default=EXCLUDE_DEFAULT,
                    help="Pfad-Ausschluss (Regex auf den vollen Pfad; '' = aus)")
    ap.add_argument("--prefer", default=PREFER_DEFAULT,
                    help="Ordner-Praeferenz (Regex; Treffer zuerst; '' = aus)")
    ap.add_argument("--max-mb", type=float, default=20.0,
                    help="Obergrenze je Datei (Standard 20 MB - keine Riesen-Dateien)")
    ap.add_argument("--only", help="Datei mit Pfaden (eine Zeile je Titel) statt Suche in --roots")
    ap.add_argument("--yes", action="store_true", help="wirklich hochladen")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--manifest", default="data/r2-pakete", help="Zielordner fuer das JSON-Manifest")
    args = ap.parse_args()

    env = read_env(".env", ".env.deploy")
    target = s3lite.S3Target.from_r2_env(env)
    existing = list_existing_keys(target)
    existing_stems = {os.path.splitext(k.split("/")[-1])[0] for k in existing}

    if args.only:
        paths = [l.strip() for l in open(args.only, encoding="utf-8") if l.strip()]
        raw = []
        for p in paths:
            ext = os.path.splitext(p)[1].lower()
            if ext in AUDIO_EXT and os.path.isfile(p):
                raw.append((p, os.path.getsize(p),
                            BUCKET_PREFIX + key_stem(os.path.splitext(os.path.basename(p))[0]) + ext,
                            genre_of(p), os.path.basename(os.path.dirname(p))))
    else:
        genre_re = re.compile(args.genre, re.IGNORECASE) if args.genre else None
        raw = collect(args.roots, args.min_mb, args.max_mb, genre_re, not args.no_folder_fallback)
        if args.exclude:
            excl = re.compile(args.exclude, re.IGNORECASE)
            raw = [r for r in raw if not excl.search(r[0])]
        if args.prefer:
            pref = re.compile(args.prefer, re.IGNORECASE)
            raw.sort(key=lambda r: (0 if pref.search(os.path.dirname(r[0])) else 1, r[0]))

    chosen: List[Tuple[str, int, str, str, str]] = []
    seen_keys, seen_sizes = set(), set()
    for path, size, key, genre, ordner in raw:
        stem = os.path.splitext(key.split("/")[-1])[0]
        if stem in existing_stems or key in seen_keys or (stem, size) in seen_sizes:
            continue
        seen_keys.add(key)
        seen_sizes.add((stem, size))
        chosen.append((path, size, key, genre, ordner))
        if len(chosen) >= args.limit:
            break

    total_mb = sum(item[1] for item in chosen) / 2**20
    print(f"Bucket: {target.bucket}  |  vorhanden unter music/: {len(existing)}")
    print(f"Kandidaten nach Genre-Filter: {len(raw)}")
    print(f"Auswahl: {len(chosen)} Titel, {total_mb:.1f} MB (Grenze {args.max_mb:g} MB/Datei)")
    for path, size, key, genre, ordner in chosen[:8]:
        print(f"  {size/2**20:6.1f} MB  [{genre or '?'}]  {key}   <- {ordner}/{os.path.basename(path)}")
    if len(chosen) > 8:
        print(f"  ... {len(chosen)-8} weitere")
    if not args.yes:
        print("\nTrockenlauf - nichts hochgeladen. Mit --yes ausfuehren.")
        return 0
    if not chosen:
        print("Nichts zu tun.")
        return 0

    uploaded: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []

    def put(item):
        path, size, key = item[0], item[1], item[2]
        mime = AUDIO_EXT[os.path.splitext(path)[1].lower()]
        target.put_file(key, path, mime, meta={"quelle": "musik-archiv", "paket": dt.date.today().isoformat()})
        head = target.head(key)
        if not head or int(head.get("content-length", -1)) != size:
            raise RuntimeError("HEAD-Gegenprobe fehlgeschlagen")
        return {"key": key, "size": size, "quelle": path}

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(put, item): item for item in chosen}
        done = 0
        for fut in as_completed(futs):
            item = futs[fut]
            try:
                uploaded.append(fut.result())
            except Exception as exc:  # noqa: BLE001 - je Datei melden, nicht abbrechen
                errors.append({"key": item[2], "quelle": item[0], "fehler": str(exc)[:300]})
            done += 1
            if done % 10 == 0 or done == len(chosen):
                print(f"\r  {done}/{len(chosen)} verarbeitet, {len(errors)} Fehler", end="", flush=True)

    print()
    manifest_dir = REPO / args.manifest
    manifest_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    manifest = manifest_dir / f"musik-paket-{stamp}.json"
    manifest.write_text(json.dumps({
        "bucket": target.bucket,
        "praefix": BUCKET_PREFIX,
        "erstellt": dt.datetime.now().isoformat(timespec="seconds"),
        "grenze_mb": args.max_mb,
        "hochgeladen": len(uploaded),
        "fehler": errors,
        "titel": sorted(uploaded, key=lambda x: str(x["key"])),
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Manifest: {manifest.relative_to(REPO)}")
    print(f"hochgeladen: {len(uploaded)} | Fehler: {len(errors)} | Volumen: {sum(int(u['size']) for u in uploaded)/2**20:.1f} MB")
    return 4 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
