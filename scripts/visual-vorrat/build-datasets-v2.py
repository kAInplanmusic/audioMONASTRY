#!/usr/bin/env python3
"""Baut SDXL-LoRA-Datensaetze v2 - saubere Auswahl je Thema.

Befunde aus der Analyse der Rohdaten (belegt, nicht vermutet):
  * Spalte 'tags' ist bei einem Bild in ALLEN Themen-CSVs identisch (29339/29339).
    Sie ist NICHT themenspezifisch -> aus der Caption entfernt.
  * Die 25 Bilder in <Thema>/ hatten 'treffer' 4-6 (generisch). Je Thema gibt es
    >=25 Bilder mit 'treffer' == 1 (eindeutig) -> bessere Stilbeispiele.
  * 'ausschluss' == 'ja' ist ein echtes Ausschlusssignal -> respektiert.

Caption = "<trigger>, <BLIP-Beschreibung>".

Die Originaldateien wurden mehrfach verschoben. Deshalb loest eine Kette den
Pfad auf:
  1. absoluter Pfad wie in der CSV
  2. bilder-sortierung-umkehr.tsv  (alt -> Bilder/<neu>)
  3. Kopie im Themenordner am-visuals-themen-neu/<Thema>/
  4. eindeutiger Basisnamen-Treffer aus datei-index.json
"""
from __future__ import annotations

import csv
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageFile

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_OK = True
except Exception:  # pragma: no cover
    HEIF_OK = False

ImageFile.LOAD_TRUNCATED_IMAGES = True
Image.MAX_IMAGE_PIXELS = None

BASE = Path(__file__).parent
HOME = Path("/home/patrick")
SRC = HOME / "am-visuals-themen-neu"
LISTEN = SRC / "_listen"
BILDER = HOME / "Bilder"
UMKEHR_TSV = HOME / "bilder-sortierung-umkehr.tsv"
INDEX_JSON = BASE / "datei-index.json"
OUT = BASE / "out-v2"

TRIGGER_PREFIX = "mstyle"
PER_THEME = 25
MAX_SIDE = 1536
JPEG_QUALITY = 95


def slugify(name: str) -> str:
    s = name.replace("–", "-").replace("—", "-").replace("ä", "ae").replace("ö", "oe")
    s = s.replace("ü", "ue").replace("ß", "ss")
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").lower()


def fnum(r: dict, k: str) -> float:
    try:
        return float(r.get(k) or 0)
    except (TypeError, ValueError):
        return 0.0


def load_rows(p: Path) -> list[dict]:
    with p.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        return list(csv.DictReader(fh, delimiter=";"))


def load_umkehr() -> dict[str, str]:
    m: dict[str, str] = {}
    if not UMKEHR_TSV.exists():
        return m
    with UMKEHR_TSV.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 2 or parts[0] == "alt":
                continue
            m.setdefault(parts[0], parts[1])
    return m


def load_index() -> dict[str, list[str]]:
    if not INDEX_JSON.exists():
        return {}
    return json.loads(INDEX_JSON.read_text())


def resolve(orig: str, theme_dir: Path, umkehr: dict[str, str], index: dict[str, list[str]]):
    """Gibt (pfad, quelle) oder (None, grund)."""
    p = Path(orig)
    if p.exists():
        return p, "original"
    base = os.path.basename(orig)

    neu = umkehr.get(base)
    if neu:
        cand = BILDER / neu
        if cand.exists():
            return cand, "umkehr"

    cand = theme_dir / base
    if cand.exists():
        return cand, "themenordner"

    hits = index.get(base, [])
    if len(hits) == 1:
        c = Path(hits[0])
        if c.exists():
            return c, "index"
    if len(hits) > 1:
        return None, f"mehrdeutig_{len(hits)}"
    return None, "nicht_gefunden"


def load_image(path: Path) -> Image.Image:
    if path.suffix.lower() == ".dng":
        with tempfile.TemporaryDirectory() as td:
            work = Path(td) / path.name
            work.write_bytes(path.read_bytes())
            res = subprocess.run(["dcraw", "-T", "-w", str(work)], capture_output=True, text=True, timeout=300)
            tiff = work.with_suffix(work.suffix + ".tiff")
            if not tiff.exists():
                c = list(Path(td).glob("*.tiff"))
                if c:
                    tiff = c[0]
            if res.returncode != 0 or not tiff.exists() or tiff.stat().st_size == 0:
                raise RuntimeError("dcraw: " + (res.stderr or res.stdout).strip()[:120])
            im = Image.open(tiff)
            im.load()
            return im
    im = Image.open(path)
    im.load()
    return im


def to_rgb(img: Image.Image) -> Image.Image:
    if img.mode in ("RGBA", "LA", "PA", "P"):
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[-1])
        return bg
    return img.convert("RGB")


def main() -> int:
    umkehr = load_umkehr()
    index = load_index()
    print(f"[v2] {len(umkehr)} Umkehr-Eintraege | {len(index)} Index-Basisnamen | HEIC: {'ja' if HEIF_OK else 'NEIN'}")

    themes = sorted(p.stem for p in LISTEN.glob("*.csv"))
    OUT.mkdir(parents=True, exist_ok=True)
    summary: dict[str, dict] = {}
    total = 0
    sources_used: dict[str, int] = {}

    for theme in themes:
        slug = slugify(theme)
        trigger = f"{TRIGGER_PREFIX}_{slug}"
        theme_dir = SRC / theme
        rows = load_rows(LISTEN / f"{theme}.csv")
        clean = [r for r in rows if fnum(r, "treffer") == 1 and not (r.get("ausschluss") or "").strip()]
        clean.sort(key=lambda r: -fnum(r, "aesthetik"))

        img_out = OUT / slug / "images"
        if img_out.exists():
            shutil.rmtree(img_out)
        img_out.mkdir(parents=True, exist_ok=True)

        written: list[dict] = []
        rejected: list[dict] = []
        n = 0
        for r in clean:
            if n >= PER_THEME:
                break
            orig = (r.get("original") or "").strip()
            if not orig:
                continue
            desc = (r.get("beschreibung") or "").strip()
            if not desc:
                rejected.append({"file": os.path.basename(orig), "reason": "beschreibung_leer"})
                continue
            src, how = resolve(orig, theme_dir, umkehr, index)
            if src is None:
                rejected.append({"file": os.path.basename(orig), "reason": how})
                continue
            try:
                img = to_rgb(load_image(src))
                w, h = img.size
                if max(w, h) > MAX_SIDE:
                    s = MAX_SIDE / max(w, h)
                    img = img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
                n += 1
                stem = re.sub(r"[^A-Za-z0-9_\-]+", "_", Path(orig).stem[:40])
                out_base = f"{n:02d}_{stem}"
                img.save(img_out / f"{out_base}.jpg", "JPEG", quality=JPEG_QUALITY, optimize=True)
                (img_out / f"{out_base}.txt").write_text(f"{trigger}, {desc}\n", encoding="utf-8")
                sources_used[how] = sources_used.get(how, 0) + 1
                written.append(
                    {
                        "file": os.path.basename(orig),
                        "resolved_from": how,
                        "aesthetik": r.get("aesthetik"),
                        "caption": f"{trigger}, {desc}"[:200],
                    }
                )
            except Exception as exc:
                rejected.append({"file": os.path.basename(orig), "reason": f"verarbeitung: {exc}"[:130]})

        man = {
            "theme": theme,
            "slug": slug,
            "trigger": trigger,
            "csv_rows": len(rows),
            "clean_candidates": len(clean),
            "images_written": len(written),
            "used_filter": "treffer==1 AND ausschluss leer, sortiert nach aesthetik",
            "caption_rule": "trigger + BLIP-Beschreibung (ohne tags)",
            "rejected": rejected[:60],
            "rejected_total": len(rejected),
            "written": written,
        }
        (OUT / slug / "manifest.json").write_text(json.dumps(man, ensure_ascii=False, indent=2), encoding="utf-8")
        summary[slug] = {
            "theme": theme,
            "trigger": trigger,
            "clean_candidates": len(clean),
            "written": len(written),
            "rejected": len(rejected),
        }
        total += len(written)
        flag = "OK " if len(written) >= PER_THEME else "!! "
        print(f"{flag}{slug:38} {len(written):2d}/{PER_THEME} aus {len(clean):5d} Kandidaten")

    (OUT / "_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[v2] FERTIG: {len(summary)} Themen, {total} Bilder -> {OUT}")
    print(f"[v2] Herkunft der Dateien: {sources_used}")
    weak = {k: v for k, v in summary.items() if v["written"] < PER_THEME}
    if weak:
        print(f"[v2] {len(weak)} Thema(en) unter {PER_THEME}:")
        for k, v in weak.items():
            print(f"[v2]   {k}: {v['written']} (Kandidaten {v['clean_candidates']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
