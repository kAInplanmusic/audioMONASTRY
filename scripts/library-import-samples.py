#!/usr/bin/env python3
"""Sample-Paket analysieren und als Bibliothekszeilen eintragen (`samples`).

WARUM: `scripts/upload-samples-batch.py` legt nur die WAVs nach R2. Damit die
App sie findet und sinnvoll filtern kann, braucht jede Datei eine Zeile in
`public.samples` - mit mehr als Namen und URL: Kategorie, Typ, Interpret, Stil,
Dauer, Samplerate, Bittiefe, Loudness, Tempo, Tonart, Tags. Genau das misst
`scripts/audio_meta.py` (ffprobe/ffmpeg/numpy) und leitet der Rest dieses
Skripts aus Pack- und Dateinamen ab.

Regeln
  * Gemessen wird an der ORIGINALDATEI (nicht am Objekt in R2).
  * BPM/Tonart nur, wenn die Messung Konfidenz hat - sonst leer. Ein falsches
    Tempo in der Bibliothek ist schlimmer als ein leeres Feld.
  * Ein-Shots (Kick/Snare/...) bekommen nie ein Tempo; nur Tonspuren ab 8 s.
  * Idempotent: id = "sample-" + sha1(key)[:12], upsert auf id.

Aufruf:
    python3 scripts/library-import-samples.py                       # Trockenlauf
    python3 scripts/library-import-samples.py --yes                 # schreiben
    python3 scripts/library-import-samples.py --limit 20 --yes      # kleine Runde
    python3 scripts/library-import-samples.py --manifest data/r2-pakete/samples-....json --yes

Exit: 0 ok · 2 Konfiguration · 4 Schreibfehler.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

REPO = pathlib.Path(__file__).resolve().parent.parent
AUDIO_EXT = {".wav", ".flac", ".mp3", ".aif", ".aiff", ".ogg", ".m4a"}
sys.path.insert(0, str(REPO / "scripts"))
from audio_meta import analyze  # noqa: E402

#: Dateiname-Schluesselwort -> (Typ, Kategorie)
TYPE_RULES = [
    (r"kick|bassdrum|\bbd\b", "Kick", "bass"),
    (r"snare|\bsd\b|rimshot", "Snare", "mids"),
    (r"clap", "Clap", "mids"),
    (r"hi.?hat|\bhh\b|\bch\b|\boh\b", "HiHat", "highs"),
    (r"cymbal|crash|ride", "Cymbal", "highs"),
    (r"shaker|tambour", "Shaker", "highs"),
    (r"\btom\b", "Tom", "bass"),
    (r"perc", "Perc", "mids"),
    (r"sub|bass", "Bass", "bass"),
    (r"acid", "Acid", "mids"),
    (r"lead", "Lead", "mids"),
    (r"synth|arp", "Synth", "mids"),
    (r"pad|string", "Pad", "mids"),
    (r"chord|stab", "Chord", "mids"),
    (r"fx|riser|sweep|noise|impact", "FX", "mids"),
    (r"vox|vocal|voice|choir", "Vocal", "mids"),
    (r"break", "Break", "mids"),
    (r"loop", "Loop", "mids"),
    (r"ambi", "Ambience", "mids"),
    (r"drum|beat|hit|one.?shot", "Drum", "mids"),
]
#: Stil-Schluesselwort -> Anzeigename
STYLE_RULES = [
    (r"speedcore", "Speedcore"), (r"breakcore", "Breakcore"), (r"doomcore", "Doomcore"),
    (r"gabber", "Gabber"), (r"hardcore", "Hardcore"), (r"industrial", "Industrial"),
    (r"black metal|metal", "Metal"), (r"techno", "Techno"), (r"house", "House"),
    (r"drum.{0,3}bass|dnb", "Drum & Bass"), (r"ambient", "Ambient"), (r"electro", "Electro"),
]


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
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def split_artist(pack: str) -> tuple[str, str]:
    """'Low Entropy - 55 Royalty Free Drums' -> ('Low Entropy', '55 Royalty Free Drums')."""
    if " - " in pack:
        head, rest = pack.split(" - ", 1)
        if re.search(r"[A-Za-z]", head) and len(head) <= 40:
            return head.strip(), rest.strip()
    return "", pack


def detect_style(*texts: str) -> str:
    blob = " ".join(texts).lower()
    for pattern, name in STYLE_RULES:
        if re.search(pattern, blob):
            return name
    # Kein Genrebegriff im Pack/Dateinamen: "Electronic" ist die ehrliche
    # Ueberschrift - "Electro" waere eine falsche Zuschreibung (Electro-Clash).
    return "Electronic"


def detect_type(title: str, *context: str) -> tuple[str, str]:
    """Typ zuerst aus dem DATEINAMEN, erst dann aus Pack/Ordnern.

    WARUM: Packnamen wie "... Speedcore Bassdrums" enthalten "bass" - wuerde man
    sie zuerst pruefen, waeren alle 44 Dateien eines Bassdrum-Packs "Bass",
    obwohl die Haelfte Kicks und Snares sind.
    """
    for pattern, name, cat in TYPE_RULES:
        if re.search(pattern, title.lower()):
            return name, cat
    blob = " ".join(context).lower()
    for pattern, name, cat in TYPE_RULES:
        if re.search(pattern, blob):
            return name, cat
    return "Sample", "mids"


def clean_title(stem: str, pack: str) -> str:
    s = stem
    for cand in (pack, re.sub(r"\s*\(.*?\)", "", pack)):
        if cand and s.lower().startswith(cand.lower()):
            s = s[len(cand):].lstrip(" -_")
    s = re.sub(r"^\d{1,3}\s*[-._ ]+\s*", "", s)
    s = s.replace("_", " ").replace("&", "&")
    s = re.sub(r"\s{2,}", " ", s).strip(" -_")
    return s or stem


def build_row(entry: Dict, public: str) -> Dict:
    path = str(entry["quelle"])
    key = str(entry["key"])
    stem = os.path.splitext(os.path.basename(path))[0]
    pack = str(entry.get("pack") or "")
    artist, pack_rest = split_artist(pack)
    title = clean_title(stem, pack)

    meta = analyze(path)
    typ, category = detect_type(title, pack_rest)
    style = detect_style(pack, title)
    duration = meta["duration_seconds"] or 0
    kind = "recording" if duration >= 60 else "sample"
    if kind == "recording":
        typ = "Track"  # ganze Titel, keine Einzel-Samples

    tags = [slug(pack)[:40]] if pack else []
    tags += [slug(style), slug(typ), category, kind]
    if meta.get("bpm"):
        tags.append("loop")
    tags += ["r2", "icloud-samples"]

    bits = f"{meta['bit_depth']} bit" if meta.get("bit_depth") else ""
    rate = f"{meta['sample_rate']/1000:g} kHz" if meta.get("sample_rate") else ""
    parts = [x for x in (pack_rest or pack, typ, style, f"{rate}/{bits}" if rate and bits else rate or bits) if x]
    if duration:
        parts.append(f"{duration:.2f} s")
    if meta.get("lufs") is not None:
        parts.append(f"{meta['lufs']:.1f} LUFS")
    if meta.get("bpm"):
        parts.append(f"{meta['bpm']:g} BPM")
    if meta.get("key"):
        parts.append(meta["key"])

    return {
        "id": "sample-" + hashlib.sha1(key.encode()).hexdigest()[:12],
        "name": title[:200],
        "category": category,
        "type": typ,
        "kind": kind,
        "artist": artist or None,
        "style": style,
        "key": meta.get("key"),
        "bpm": meta.get("bpm"),
        "duration_seconds": meta.get("duration_seconds"),
        "sample_rate": meta.get("sample_rate"),
        "lufs": meta.get("lufs"),
        "file_size": meta.get("file_size") or int(entry.get("size") or 0),
        "url": public.rstrip("/") + "/" + key,
        "description": " · ".join(parts)[:400],
        "tags": tags,
        "parameters": {
            "pack": pack,
            "original_path": path,
            "codec": meta.get("codec"),
            "bit_depth": meta.get("bit_depth"),
            "channels": meta.get("channels"),
            "peak_dbtp": meta.get("peak_dbtp"),
            "lra": meta.get("lra"),
        },
        "source": "r2",
    }


def post_rows(base: str, key: str, rows: List[Dict]) -> List[str]:
    errors: List[str] = []
    for i in range(0, len(rows), 50):
        chunk = rows[i:i + 50]
        req = urllib.request.Request(
            f"{base}/rest/v1/samples?on_conflict=id",
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
            with urllib.request.urlopen(req, timeout=120) as resp:
                if resp.status >= 300:
                    errors.append(f"PostgREST {resp.status}: {resp.read()[:200]!r}")
                    continue
        except urllib.error.HTTPError as exc:
            errors.append(f"PostgREST {exc.code}: {exc.read().decode(errors='replace')[:300]}")
            continue
        print(f"  geschrieben: {min(i + 50, len(rows))}/{len(rows)}")
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description="Samples analysieren und in die Bibliothek eintragen")
    ap.add_argument("--manifest")
    ap.add_argument("--root", help="statt Manifest: Ordner direkt einlesen")
    ap.add_argument("--prefix", default="samples/")
    ap.add_argument("--limit", type=int, default=0, help="nur die ersten N Dateien (Test)")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--save-rows", help="berechnete Zeilen als JSON ablegen (ohne Schreiben)")
    ap.add_argument("--rows", help="Zeilen aus dieser JSON schreiben (ohne neue Analyse)")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    env = read_env(".env", ".env.deploy")
    base = (env.get("VITE_SUPABASE_URL") or "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    public = (env.get("CFR2_PUBLIC_URL") or env.get("CFS3_PUBLIC_URL") or "").rstrip("/")
    if args.rows:
        rows = json.loads(pathlib.Path(args.rows).read_text())
        print(f"Zeilen aus {args.rows}: {len(rows)}")
        errors = post_rows(base, key, rows) if args.yes else []
        if not args.yes:
            print("Trockenlauf - nichts geschrieben. Mit --yes ausfuehren.")
            return 0
        print(f"fertig: {len(rows)} Zeilen upgesertet, {len(errors)} Schreibfehler")
        return 4 if errors else 0

    if not base or not key or not public:
        print("Fehlt in .env: VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CFR2_PUBLIC_URL", file=sys.stderr)
        return 2

    if args.root:
        entries = []
        base_dir = pathlib.Path(args.root)
        for path in sorted(base_dir.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in AUDIO_EXT:
                continue
            rel = path.relative_to(base_dir)
            parts = [slug(p) for p in rel.parts[:-1]]
            key = args.prefix + "/".join(parts + [slug(path.stem) + path.suffix.lower()])
            entries.append({
                "key": key,
                "size": path.stat().st_size,
                "quelle": str(path),
                "pack": rel.parts[0] if len(rel.parts) > 1 else "",
            })
        print(f"Quelle: {args.root}  |  Dateien: {len(entries)}")
        if args.limit:
            entries = entries[:args.limit]
        manifest = {}
    else:
        entries = []

    mpath = args.manifest
    if not args.root and not mpath:
        found = sorted((REPO / "data/r2-pakete").glob("samples-*.json"))
        if not found:
            print("Kein Manifest (data/r2-pakete/samples-*.json)", file=sys.stderr)
            return 2
        mpath = str(found[-1])
        manifest = json.loads(pathlib.Path(mpath).read_text())
        entries = [e for e in (manifest.get("dateien") or [])
                   if os.path.splitext(str(e.get("key", "")))[1].lower() in AUDIO_EXT]
        if args.limit:
            entries = entries[:args.limit]
        print(f"Manifest: {mpath}  |  Dateien: {len(entries)}")

    rows: List[Dict] = []
    failures: List[str] = []

    def work(entry: Dict):
        try:
            return build_row(entry, public)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{entry.get('key')}: {exc}")
            return None

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, row in enumerate(pool.map(work, entries), 1):
            if row:
                rows.append(row)
            if i % 50 == 0 or i == len(entries):
                print(f"\r  analysiert: {i}/{len(entries)} ({len(failures)} Fehler)", end="", flush=True)
    print()

    for r in rows[:5]:
        print(f"  {r['name'][:44]:46} | {r['type']:8} {r['category']:6} | {r['style']:10} | "
              f"{r['duration_seconds']}s {r['bpm'] or '-':>6} {r['key'] or '-':7} | {r['lufs']}")
    if len(rows) > 5:
        print(f"  ... {len(rows)-5} weitere")
    print(f"Zeilen: {len(rows)}  Fehler bei Analyse: {len(failures)}")
    for f in failures[:5]:
        print("   !", f[:160])

    if args.save_rows:
        out = REPO / args.save_rows
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Zeilen gespeichert: {out.relative_to(REPO)}")

    if not args.yes:
        print("\nTrockenlauf - nichts geschrieben. Mit --yes ausfuehren.")
        return 0
    errors = post_rows(base, key, rows)
    print(f"fertig: {len(rows)} Zeilen upgesertet, {len(errors)} Schreibfehler")
    for e in errors[:5]:
        print("   !", e[:200])
    return 4 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
