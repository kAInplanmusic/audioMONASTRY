#!/usr/bin/env python3
"""
Baut SDXL-LoRA-Datensaetze je Thema aus den Themenordnern.

Quellen (nur lesend):
  Bilder : am-visuals-themen-neu/<Thema>/*            (Kopien der Originalfotos)
  Captions: am-visuals-themen-neu/_listen/<Thema>.csv (BLIP-Beschreibung + Tags je Original)

Ergebnis je Thema:
  out/<slug>/images/NN_<name>.jpg   Konvertiertes Bild (RGB, JPEG q95, lange Kante <= 1536)
  out/<slug>/images/NN_<name>.txt   Caption: "<trigger>, <beschreibung>, <tags>"
  out/<slug>/manifest.json          Zaehlungen, Herkunft je Bild, Verwurfsgruende

Exit 0 = gebaut. Nichts wird erfunden: fehlt eine Caption, wird das Bild als
"caption_missing" verworfen und gezaehlt, nicht stillschweigend behalten.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
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

HOME = Path("/home/patrick")
SRC = HOME / "am-visuals-themen-neu"
LISTEN = SRC / "_listen"
OUT = HOME / "lora-themen-2026-09-27" / "out"
TRIGGER_PREFIX = "mstyle"

MAX_SIDE = 1536
JPEG_QUALITY = 95
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".dng", ".tif", ".tiff", ".webp", ".gif", ".bmp"}


def slugify(name: str) -> str:
    s = name.replace("–", "-").replace("—", "-")
    s = s.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")
    return s.lower()


def read_captions(csv_path: Path) -> dict[str, dict]:
    """basename(original) -> {caption, tags, aesthetik}"""
    if not csv_path.exists():
        return {}
    out: dict[str, dict] = {}
    with csv_path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh, delimiter=";")
        for row in reader:
            orig = (row.get("original") or "").strip()
            if not orig:
                continue
            key = os.path.basename(orig)
            out[key] = {
                "caption": (row.get("beschreibung") or "").strip(),
                "tags": (row.get("tags") or "").strip(),
                "aesthetik": (row.get("aesthetik") or "").strip(),
            }
    return out


def dng_to_image(path: Path) -> Image.Image:
    """DNG via dcraw -> TIFF -> PIL.

    Dieser dcraw-Build (v9.28) kennt kein -O, sondern schreibt <name>.tiff neben
    die Eingabe. Deshalb wird die DNG zuerst in ein Temp-Verzeichnis kopiert.
    """
    with tempfile.TemporaryDirectory() as td:
        work = Path(td) / path.name
        work.write_bytes(path.read_bytes())
        res = subprocess.run(
            ["dcraw", "-T", "-w", str(work)],
            capture_output=True,
            text=True,
            timeout=300,
        )
        tiff = work.with_suffix(work.suffix + ".tiff")
        if not tiff.exists():
            for cand in Path(td).glob("*.tiff"):
                tiff = cand
                break
        if res.returncode != 0 or not tiff.exists() or tiff.stat().st_size == 0:
            raise RuntimeError(f"dcraw fehlgeschlagen: {(res.stderr or res.stdout).strip()[:200]}")
        img = Image.open(tiff)
        img.load()
        return img


def load_image(path: Path) -> Image.Image:
    ext = path.suffix.lower()
    if ext == ".dng":
        return dng_to_image(path)
    img = Image.open(path)
    img.load()
    return img


def to_rgb(img: Image.Image) -> Image.Image:
    if img.mode in ("RGBA", "LA", "PA"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
        return bg
    if img.mode == "P":
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        return bg
    return img.convert("RGB")


def build_caption(trigger: str, description: str, tags: str) -> str:
    parts = [trigger]
    if description:
        parts.append(description)
    if tags:
        clean = [t.strip() for t in tags.split("|") if t.strip()]
        # Tags mehrfach vorkommend entfernen, Reihenfolge erhalten
        seen, uniq = set(), []
        for t in clean:
            if t.lower() not in seen:
                seen.add(t.lower())
                uniq.append(t)
        parts.append(", ".join(uniq))
    return ", ".join(parts)


def main() -> int:
    if not SRC.is_dir():
        print(f"FEHLER: {SRC} fehlt", file=sys.stderr)
        return 2

    themes = sorted(d for d in SRC.iterdir() if d.is_dir() and d.name != "_listen")
    if not themes:
        print("FEHLER: keine Themenordner gefunden", file=sys.stderr)
        return 2

    print(f"[datasets] {len(themes)} Themenordner gefunden")
    print(f"[datasets] HEIC-Unterstuetzung: {'ja' if HEIF_OK else 'NEIN'}")
    print()

    OUT.mkdir(parents=True, exist_ok=True)
    summary: dict[str, dict] = {}
    total_written = 0

    for theme_dir in themes:
        theme = theme_dir.name
        slug = slugify(theme)
        trigger = f"{TRIGGER_PREFIX}_{slug}"
        captions = read_captions(LISTEN / f"{theme}.csv")

        img_out = OUT / slug / "images"
        img_out.mkdir(parents=True, exist_ok=True)
        for old in img_out.iterdir():
            if old.is_file():
                old.unlink()

        files = sorted(p for p in theme_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)

        written: list[dict] = []
        rejected: list[dict] = []
        idx = 0

        for p in files:
            key = p.name
            info = captions.get(key)
            if info is None:
                rejected.append({"file": key, "reason": "keine_zeile_in_csv"})
                continue
            if not info["caption"] and not info["tags"]:
                rejected.append({"file": key, "reason": "caption_leer"})
                continue
            try:
                img = load_image(p)
            except Exception as exc:
                rejected.append({"file": key, "reason": f"lesen_fehlgeschlagen: {exc}"[:160]})
                continue
            try:
                img = to_rgb(img)
                w, h = img.size
                if max(w, h) > MAX_SIDE:
                    scale = MAX_SIDE / max(w, h)
                    img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
                idx += 1
                stem = p.stem[:40]
                stem = re.sub(r"[^A-Za-z0-9_\-]+", "_", stem)
                base = f"{idx:02d}_{stem}"
                img.save(img_out / f"{base}.jpg", "JPEG", quality=JPEG_QUALITY, optimize=True)
                (img_out / f"{base}.txt").write_text(
                    build_caption(trigger, info["caption"], info["tags"]) + "\n", encoding="utf-8"
                )
                written.append(
                    {
                        "file": key,
                        "out": f"{base}.jpg",
                        "aesthetik": info["aesthetik"],
                        "caption_source": "blip+bildanalyse",
                        "size": [img.size[0], img.size[1]],
                    }
                )
            except Exception as exc:
                rejected.append({"file": key, "reason": f"verarbeiten_fehlgeschlagen: {exc}"[:160]})

        manifest = {
            "theme": theme,
            "slug": slug,
            "trigger": trigger,
            "images_found": len(files),
            "images_written": len(written),
            "rejected": rejected,
            "written": written,
        }
        (OUT / slug / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        summary[slug] = {
            "theme": theme,
            "trigger": trigger,
            "found": len(files),
            "written": len(written),
            "rejected": len(rejected),
        }
        total_written += len(written)
        flag = "OK " if len(written) == len(files) else "!! "
        print(f"{flag}{slug:38} {len(written):2d}/{len(files):2d} Bilder  trigger={trigger}")

    (OUT / "_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print()
    print(f"[datasets] FERTIG: {len(summary)} Themen, {total_written} Bilder geschrieben -> {OUT}")
    weak = {k: v for k, v in summary.items() if v["written"] < v["found"]}
    if weak:
        print(f"[datasets] {len(weak)} Thema(en) mit Verwuerfen:")
        for k, v in weak.items():
            print(f"[datasets]   {k}: {v['written']}/{v['found']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
