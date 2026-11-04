#!/usr/bin/env python3
"""Sample-Pakete (iCloud-Ordner SAMPLES) komplett nach R2 legen.

WARUM: Die Pack-Sammlung liegt als Ordnerbaum auf der Platte (Spiegel des
iCloud-Ordners `SAMPLES`). Die App adressiert Samples ueber
`<CFR2_PUBLIC_URL>/<key>` (Tabelle `samples.url`), der Upload-Weg des Servers
schreibt nach `uploads/samples/`. Fuer die kuratierten Packs ist ein
strukturierter Praefix besser: `samples/<pack>/<datei>.<endung>` - der Packname
bleibt sichtbar, ein Upload je Pack ist wiederholbar, und die Zuordnung steht
im Manifest.

Aufruf:
    python3 scripts/upload-samples-batch.py                      # Trockenlauf
    python3 scripts/upload-samples-batch.py --yes                 # hochladen
    python3 scripts/upload-samples-batch.py --yes --root <ordner> --prefix samples/
    python3 scripts/upload-samples-batch.py --max-mb 50 --yes     # nur kleine Dateien

Eigenschaften:
  * Schluessel werden geslugt (wie `safeName` im Server), Kollisionen bekommen
    `-2`, `-3`, ... - der Packordner bleibt als eine Ebene erhalten.
  * Bereits vorhandene Schluessel werden per LIST uebersprungen (idempotent).
  * Jede Datei wird nach dem PUT per HEAD auf gleiche Groesse geprueft.
  * Manifest: data/r2-pakete/samples-<stamp>.json (Schluessel, Groesse, Quelle).

Exit: 0 ok · 2 Konfiguration · 4 Fehler bei Dateien.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Tuple

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
import s3lite  # noqa: E402

DEFAULT_ROOT = "/mnt/wd-elements/Medien/iCloud-Musik/SAMPLES"
DEFAULT_PREFIX = "samples/"
MIME = {
    ".wav": "audio/wav", ".wave": "audio/wav", ".aif": "audio/aiff", ".aiff": "audio/aiff",
    ".flac": "audio/flac", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".txt": "text/plain", ".pdf": "application/pdf",
}


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


def slug(text: str) -> str:
    """Wie `safeName` im Server: lowercase, Nicht-Alphanumerisches -> '-'."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "datei"


def list_existing(target: s3lite.S3Target, prefix: str) -> set:
    keys: set = set()
    token = ""
    while True:
        q = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if token:
            q["continuation-token"] = token
        status, _, body = target._request("GET", "", query=q)
        if status >= 300:
            raise SystemExit(f"LIST {prefix}: HTTP {status}")
        root = ET.fromstring(body)
        ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
        for el in root.findall(".//s3:Contents/s3:Key", ns) or root.findall(".//Contents/Key"):
            keys.add(el.text or "")
        truncated = (root.findtext(".//s3:IsTruncated", "", ns) or root.findtext(".//IsTruncated", "") or "").lower()
        if truncated != "true":
            break
        token = (root.findtext(".//s3:NextContinuationToken", "", ns)
                 or root.findtext(".//NextContinuationToken", "") or "")
        if not token:
            break
    return keys


def collect(root: str, prefix: str, max_mb: float) -> List[Tuple[str, int, str, str]]:
    """(pfad, groesse, key, pack) fuer alle Dateien unter root."""
    out: List[Tuple[str, int, str, str]] = []
    base = pathlib.Path(root)
    if not base.is_dir():
        raise SystemExit(f"Quelle fehlt: {root}")
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext not in MIME:
            continue
        size = path.stat().st_size
        if max_mb > 0 and size > max_mb * 2**20:
            continue
        rel = path.relative_to(base)
        parts = [slug(p) for p in rel.parts[:-1]]
        stem = slug(path.stem)
        key = prefix + ("/".join(parts + [stem + ext]))
        pack = rel.parts[0] if len(rel.parts) > 1 else ""
        out.append((str(path), size, key, pack))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Sample-Ordner komplett nach R2 legen")
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--prefix", default=DEFAULT_PREFIX)
    ap.add_argument("--max-mb", type=float, default=0.0, help="0 = keine Obergrenze (komplett)")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--manifest", default="data/r2-pakete")
    args = ap.parse_args()

    target = s3lite.S3Target.from_r2_env(read_env(".env", ".env.deploy"))
    existing = list_existing(target, args.prefix)
    items = collect(args.root, args.prefix, args.max_mb)

    # Kollisionen deterministisch aufloesen: erstes Vorkommen gewinnt.
    used = set(existing)
    chosen: List[Tuple[str, int, str, str]] = []
    skipped = 0
    for path, size, key, pack in items:
        if key in used:
            if key in existing:
                skipped += 1
                continue
            stem, ext = os.path.splitext(key)
            n = 2
            while f"{stem}-{n}{ext}" in used:
                n += 1
            key = f"{stem}-{n}{ext}"
        used.add(key)
        chosen.append((path, size, key, pack))

    total_gb = sum(i[1] for i in chosen) / 2**30
    print(f"Bucket: {target.bucket}  Prefix: {args.prefix}")
    print(f"Quelle: {args.root}")
    print(f"Dateien: {len(items)}  |  schon in R2: {skipped}  |  neu: {len(chosen)}  |  {total_gb:.2f} GiB")
    packs: Dict[str, int] = {}
    for _, s, _, p in chosen:
        packs[p] = packs.get(p, 0) + s
    for p, s in sorted(packs.items(), key=lambda kv: -kv[1])[:6]:
        print(f"  {s/2**20:8.1f} MB  {p or '(ohne Pack)'}")
    if not args.yes:
        print("\nTrockenlauf - nichts hochgeladen. Mit --yes ausfuehren.")
        return 0
    if not chosen:
        print("Nichts zu tun.")
        return 0

    ok: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []

    def put(item: Tuple[str, int, str, str]) -> Dict[str, Any]:
        path, size, key, pack = item
        mime = MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
        # Metadaten gehen als HTTP-Header raus: nur latin-1-faehige Zeichen.
        # ("Les Champs Métalliques" mit kombinierendem Akzent brach den PUT.)
        safe_pack = pack[:120].encode("latin-1", "replace").decode("latin-1")
        target.put_file(key, path, mime, meta={"quelle": "icloud-samples", "pack": safe_pack})
        head = target.head(key)
        if not head or int(head.get("content-length", -1)) != size:
            raise RuntimeError("HEAD-Gegenprobe fehlgeschlagen")
        return {"key": key, "size": size, "pack": pack, "quelle": path}

    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(put, it): it for it in chosen}
        for fut in as_completed(futures):
            it = futures[fut]
            try:
                ok.append(fut.result())
            except Exception as exc:  # noqa: BLE001
                errors.append({"key": it[2], "quelle": it[0], "fehler": str(exc)[:300]})
            done += 1
            if done % 20 == 0 or done == len(chosen):
                print(f"\r  {done}/{len(chosen)} - {len(errors)} Fehler", end="", flush=True)
    print()

    outdir = REPO / args.manifest
    outdir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    manifest = outdir / f"samples-{stamp}.json"
    manifest.write_text(json.dumps({
        "bucket": target.bucket,
        "praefix": args.prefix,
        "quelle": args.root,
        "erstellt": dt.datetime.now().isoformat(timespec="seconds"),
        "hochgeladen": len(ok),
        "uebersprungen": skipped,
        "fehler": errors,
        "dateien": sorted(ok, key=lambda x: str(x["key"])),
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Manifest: {manifest.relative_to(REPO)}")
    print(f"hochgeladen: {len(ok)} | Fehler: {len(errors)} | Volumen: {sum(int(f['size']) for f in ok)/2**30:.2f} GiB")
    return 4 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
