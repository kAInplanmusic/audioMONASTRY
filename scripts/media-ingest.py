#!/usr/bin/env python3
"""Medien-Ingest: eine Platte/einen Ordner (z. B. die WD-2-TB-Platte „BRAIN") in den Speicher laden.

Läuft auf dem Rechner, an dem die Platte hängt (Linux, macOS, Windows; nur Python 3.9+).
Nimmt Ton (auch verlustfrei/HQ), Bilder, Videos, MIDI und Farb-LUTs auf; alles andere
wird übersprungen und gezählt.

    python3 scripts/media-ingest.py /media/<user>/BRAIN                 # nur zählen + Kosten
    python3 scripts/media-ingest.py /media/<user>/BRAIN --yes           # hochladen (B2)
    python3 scripts/media-ingest.py D:\\ --yes --target r2 --kinds audio
    python3 scripts/media-ingest.py ~/Musik --yes --tag techno --tag elektro

Ablage (inhaltsadressiert, dadurch doppelte Dateien nur einmal, Wiederholungen gefahrlos):
    media/<art>/<sha256[:2]>/<sha256>.<endung>         Original, unverändert
    media/index/<lauf>.jsonl                           je Datei: Hash, Art, Pfad, Größe, Tags

Fortsetzen: bereits hochgeladene Objekte werden per HEAD erkannt; Hashes großer Dateien
merkt sich das Skript in ~/.cache/audiomonastry-ingest/ (Pfad+Größe+Zeit), damit ein
zweiter Lauf nicht alles neu liest. Abbruch mit Strg+C jederzeit möglich.

Ziele
  b2 (Standard)  Backblaze B2: ~0,007 $/GB/Monat, günstigstes Archiv. Env: B2_BUCKET,
                 B2_KEY_ID, B2_APP_KEY, optional B2_ENDPOINT (eu-central-003).
  r2             Cloudflare R2: ~0,015 $/GB/Monat, ohne Abrufkosten, dort liest die App heute.
                 Env wie der Server: CFS3_ACCESS_KEY, CFS3_SECRET_KEY, CFS3_BUCKET, CFS3_ENDPOINT
                 oder CFR2_ACCOUNT_ID.

Exit-Codes: 0 ok · 2 Konfiguration · 3 Freigabe fehlt (nichts hochgeladen) · 4 Fehler bei Dateien
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import socket
import sys
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Dict, Iterable, Iterator, List, Optional, Tuple

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import s3lite  # noqa: E402

#: Endung → (Art, MIME). Verlustfreie/HQ-Formate ausdrücklich dabei (Betreiber 2026-10-07).
FORMATS: Dict[str, Tuple[str, str]] = {}


def _add(kind: str, mime: str, *exts: str) -> None:
    for e in exts:
        FORMATS[e] = (kind, mime)


# Ton – verlustfrei / Studio / HQ
_add("audio", "audio/wav", "wav", "wave", "bwf", "rf64", "w64")
_add("audio", "audio/aiff", "aif", "aiff", "aifc")
_add("audio", "audio/flac", "flac")
_add("audio", "audio/x-wavpack", "wv")
_add("audio", "audio/x-ape", "ape")
_add("audio", "audio/x-tta", "tta")
_add("audio", "audio/x-tak", "tak")
_add("audio", "audio/x-dsf", "dsf")
_add("audio", "audio/x-dff", "dff")
_add("audio", "audio/x-caf", "caf")
_add("audio", "audio/x-matroska", "mka")
# Ton – verlustbehaftet
_add("audio", "audio/mpeg", "mp3", "mp2")
_add("audio", "audio/mp4", "m4a", "m4b", "alac")
_add("audio", "audio/aac", "aac")
_add("audio", "audio/ogg", "ogg", "oga", "opus")
_add("audio", "audio/webm", "weba")
_add("audio", "audio/x-ms-wma", "wma")
_add("audio", "audio/ac3", "ac3", "eac3")
_add("audio", "audio/vnd.dts", "dts")
# Bilder (inkl. RAW der gängigen Kameras)
_add("image", "image/jpeg", "jpg", "jpeg", "jpe")
_add("image", "image/png", "png")
_add("image", "image/webp", "webp")
_add("image", "image/avif", "avif")
_add("image", "image/heic", "heic", "heif")
_add("image", "image/tiff", "tif", "tiff")
_add("image", "image/gif", "gif")
_add("image", "image/bmp", "bmp")
_add("image", "image/jxl", "jxl")
_add("image", "image/vnd.adobe.photoshop", "psd")
_add("image", "image/x-raw", "dng", "cr2", "cr3", "nef", "arw", "orf", "rw2", "raf", "srw", "pef")
# Video
_add("video", "video/mp4", "mp4", "m4v")
_add("video", "video/quicktime", "mov")
_add("video", "video/x-matroska", "mkv")
_add("video", "video/webm", "webm")
_add("video", "video/x-msvideo", "avi")
_add("video", "video/x-ms-wmv", "wmv")
_add("video", "video/mpeg", "mpg", "mpeg", "m2v")
_add("video", "video/mp2t", "mts", "m2ts", "ts")
_add("video", "video/3gpp", "3gp")
_add("video", "video/x-flv", "flv")
_add("video", "application/mxf", "mxf")
_add("video", "video/ogg", "ogv")
# MIDI (Sequenzer) und Farb-LUTs (Visuals)
_add("midi", "audio/midi", "mid", "midi")
_add("lut", "text/plain", "cube", "3dl")

KINDS = ("audio", "image", "video", "midi", "lut")
SKIP_DIRS = {"$recycle.bin", "system volume information", ".trash", ".trashes", ".spotlight-v100",
             ".fseventsd", ".tmp.drivedownload", "@eadir", ".ds_store", "lost+found"}
SKIP_FILES = {"thumbs.db", "desktop.ini", ".ds_store"}
PRICE_USD_PER_GB_MONTH = {"b2": 0.00695, "r2": 0.015}


@dataclass
class Item:
    path: str
    rel: str
    kind: str
    ext: str
    mime: str
    size: int
    mtime: float
    sha256: str = ""


@dataclass
class Scan:
    items: List[Item] = field(default_factory=list)
    skipped_types: Dict[str, int] = field(default_factory=dict)
    skipped_bytes: int = 0


def classify(name: str) -> Optional[Tuple[str, str, str]]:
    lower = name.lower()
    if lower in SKIP_FILES or lower.startswith("._"):
        return None
    ext = lower.rsplit(".", 1)[-1] if "." in lower else ""
    hit = FORMATS.get(ext)
    return (hit[0], ext, hit[1]) if hit else None


def scan(root: str, kinds: Iterable[str], min_bytes: int) -> Scan:
    wanted = set(kinds)
    result = Scan()
    root_path = os.path.abspath(root)
    for dirpath, dirnames, filenames in os.walk(root_path, followlinks=False):
        dirnames[:] = [d for d in dirnames if d.lower() not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full, follow_symlinks=False)
            except OSError:
                continue
            if not os.path.isfile(full) or os.path.islink(full):
                continue
            hit = classify(name)
            if not hit or hit[0] not in wanted or st.st_size < min_bytes:
                ext = name.lower().rsplit(".", 1)[-1] if "." in name else "(ohne)"
                result.skipped_types[ext] = result.skipped_types.get(ext, 0) + 1
                result.skipped_bytes += st.st_size
                continue
            rel = os.path.relpath(full, root_path).replace(os.sep, "/")
            result.items.append(Item(full, rel, hit[0], hit[1], hit[2], st.st_size, st.st_mtime))
    return result


def object_key(item: Item) -> str:
    return f"media/{item.kind}/{item.sha256[:2]}/{item.sha256}.{item.ext}"


class HashCache:
    """Merkt sich Hashes (Pfad+Größe+Zeit) zwischen Läufen – ein zweiter Lauf liest nichts neu."""

    def __init__(self, path: Optional[str]) -> None:
        self.path = path
        self.data: Dict[str, str] = {}
        self.lock = threading.Lock()
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    self.data = json.load(fh)
            except (OSError, ValueError):
                self.data = {}

    @staticmethod
    def _k(item: Item) -> str:
        return f"{item.path}|{item.size}|{int(item.mtime)}"

    def get(self, item: Item) -> str:
        return self.data.get(self._k(item), "")

    def put(self, item: Item) -> None:
        with self.lock:
            self.data[self._k(item)] = item.sha256

    def save(self) -> None:
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.data, fh)
        os.replace(tmp, self.path)


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} TB"


def report(sc: Scan, target: str) -> None:
    by_kind: Dict[str, Tuple[int, int]] = {}
    for it in sc.items:
        c, b = by_kind.get(it.kind, (0, 0))
        by_kind[it.kind] = (c + 1, b + it.size)
    total = sum(b for _, b in by_kind.values())
    print("Gefunden:")
    for kind in KINDS:
        if kind in by_kind:
            c, b = by_kind[kind]
            print(f"  {kind:6} {c:8d} Dateien  {human(b):>10}")
    print(f"  Summe  {len(sc.items):8d} Dateien  {human(total):>10}  (Doppelte werden beim Hochladen nur einmal gespeichert)")
    if sc.skipped_types:
        top = sorted(sc.skipped_types.items(), key=lambda kv: -kv[1])[:8]
        print(f"Übersprungen: {sum(sc.skipped_types.values())} Dateien, {human(sc.skipped_bytes)} – häufigste Endungen: "
              + ", ".join(f".{k} ({v})" for k, v in top))
    gb = total / 2**30
    price = PRICE_USD_PER_GB_MONTH[target]
    print(f"Speicherkosten {target.upper()}: ~{gb * price:.2f} $/Monat (~{gb * price * 0.92:.2f} €/Monat) für {gb:.0f} GB")


def ingest(sc: Scan, target: "s3lite.S3Target", tags: List[str], workers: int, cache: HashCache,
           run_id: str) -> Tuple[int, int, int]:
    """→ (neu hochgeladen, schon vorhanden, Fehler)."""
    uploaded = present = failed = 0
    index_lines: List[str] = []
    lock = threading.Lock()
    seen: Dict[str, str] = {}

    def one(item: Item) -> str:
        item.sha256 = cache.get(item) or s3lite.sha256_file(item.path)
        cache.put(item)
        key = object_key(item)
        with lock:
            first = key not in seen
            seen.setdefault(key, item.rel)
        state = "duplikat"
        if first:
            if target.head(key) is not None:
                state = "vorhanden"
            else:
                meta = {"original-name": urllib.parse.quote(os.path.basename(item.path))[:900], "kind": item.kind}
                if tags:
                    meta["tags"] = urllib.parse.quote(",".join(tags))[:900]
                target.put_file(key, item.path, item.mime, meta=meta)
                state = "neu"
        line = json.dumps({"sha256": item.sha256, "kind": item.kind, "ext": item.ext, "size": item.size, "key": key,
                           "path": item.rel, "mtime": int(item.mtime), "tags": tags, "state": state}, ensure_ascii=False)
        with lock:
            index_lines.append(line)
        return state

    total = len(sc.items)
    done = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(one, it): it for it in sc.items}
        try:
            for fut in as_completed(futures):
                it = futures[fut]
                done += 1
                try:
                    state = fut.result()
                    if state == "neu":
                        uploaded += 1
                    else:
                        present += 1
                except Exception as exc:  # noqa: BLE001 – weiter mit der nächsten Datei
                    failed += 1
                    print(f"  ✖ {it.rel}: {type(exc).__name__}: {exc}", flush=True)
                if done % 50 == 0 or done == total:
                    print(f"  {done}/{total}  neu {uploaded} · vorhanden/doppelt {present} · Fehler {failed}", flush=True)
                    cache.save()
        finally:
            cache.save()
            if index_lines:
                target.put_bytes(f"media/index/{run_id}.jsonl", ("\n".join(index_lines) + "\n").encode(), "application/x-ndjson")
    return uploaded, present, failed


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", help="Ordner oder Laufwerk, z. B. /media/<user>/BRAIN")
    parser.add_argument("--yes", action="store_true", help="wirklich hochladen")
    parser.add_argument("--target", choices=("b2", "r2"), default="b2")
    parser.add_argument("--kinds", default=",".join(KINDS), help=f"Auswahl aus {','.join(KINDS)}")
    parser.add_argument("--tag", action="append", default=[], help="Tag für alle Dateien dieses Laufs (mehrfach)")
    parser.add_argument("--min-kb", type=int, default=1, help="kleinere Dateien überspringen (Standard 1 KB)")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--no-cache", action="store_true", help="Hash-Cache nicht benutzen")
    args = parser.parse_args(argv)

    if not os.path.isdir(args.root):
        print(f"Kein Ordner: {args.root}", file=sys.stderr)
        return 2
    kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]
    bad = [k for k in kinds if k not in KINDS]
    if bad:
        print(f"Unbekannte Art(en): {bad}", file=sys.stderr)
        return 2

    sc = scan(args.root, kinds, args.min_kb * 1024)
    report(sc, args.target)
    if not sc.items:
        return 0
    if not args.yes:
        print("Ohne --yes wird nichts hochgeladen.")
        return 3
    try:
        target = s3lite.S3Target.from_b2_env() if args.target == "b2" else s3lite.S3Target.from_r2_env()
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 2
    cache_path = None if args.no_cache else os.path.join(os.path.expanduser("~"), ".cache", "audiomonastry-ingest", f"{args.target}.json")
    run_id = f"{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{socket.gethostname()[:32]}"
    uploaded, present, failed = ingest(sc, target, [t.strip().lower() for t in args.tag if t.strip()], args.workers,
                                       HashCache(cache_path), run_id)
    print(f"Fertig: {uploaded} neu, {present} schon da/doppelt, {failed} Fehler. Index: media/index/{run_id}.jsonl")
    return 0 if not failed else 4


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nAbgebrochen – ein neuer Lauf macht dort weiter.", file=sys.stderr)
        sys.exit(130)
