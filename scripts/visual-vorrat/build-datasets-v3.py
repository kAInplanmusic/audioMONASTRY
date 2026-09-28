#!/usr/bin/env python3
"""Baut die SDXL-LoRA-Datensaetze v3 - endgueltige Fassung.

Warum v3 und nicht v2 (beides wurde am Bild geprueft, nicht geraten):

  v1 (Ordnerversion)  : die 25 Bilder je Thema aus am-visuals-themen-neu/<Thema>/
                        -> am Kontrollblatt stimmig (Tattoo-Flash-Art bei Comic,
                           Frauen mit feinen Tattoos bei Tattoos_Frauen).
                        ABER: die Captions enthielten die Spalte 'tags', und die ist
                        bei einem Bild in ALLEN Themen-CSVs identisch -> haette
                        fremde Themen eingeimpft.
  v2 (treffer==1)     : "passt nur zu einem Thema" klingt sauber, ist es aber nicht.
                        Am Kontrollblatt: natur_tiere = Blumen, ein Musiker, ein
                        TikTok-Screenshot, ein Tuerriegel - kein einziges Tier.
                        tattoos_frauen = Bodybuilder, Pistole, Piercing-Schmuck.
                        treffer==1 selektiert also die SCHWACHEN Ausreisser.

  v3 (diese Datei)    : Bilder = die kuratierten Ordnerbilder (v1),
                        Captions = Trigger + echte BLIP-Beschreibung, OHNE 'tags'.
                        Damit ist beides richtig: das Bildmaterial ist das des
                        Betreibers und die Caption ist themenrein.

Zusaetzlich wird je Thema geprueft, dass die Caption wirklich aus der Zeile DIESES
Themas stammt (nicht aus einer anderen CSV).
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
OUT = BASE / "out-v3"

TRIGGER_PREFIX = "mstyle"
MAX_SIDE = 1536
JPEG_QUALITY = 95
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".dng", ".tif", ".tiff", ".webp", ".bmp"}


def slugify(name: str) -> str:
    s = name.replace("–", "-").replace("—", "-").replace("ä", "ae").replace("ö", "oe")
    s = s.replace("ü", "ue").replace("ß", "ss")
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").lower()


def read_captions(csv_path: Path) -> dict[str, dict]:
    if not csv_path.exists():
        return {}
    out: dict[str, dict] = {}
    with csv_path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        for row in csv.DictReader(fh, delimiter=";"):
            orig = (row.get("original") or "").strip()
            if not orig:
                continue
            out[os.path.basename(orig)] = {
                "caption": (row.get("beschreibung") or "").strip(),
                "aesthetik": row.get("aesthetik"),
                "treffer": row.get("treffer"),
            }
    return out


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
    if not SRC.is_dir():
        print(f"FEHLER: {SRC} fehlt", file=sys.stderr)
        return 2

    themes = sorted(d for d in SRC.iterdir() if d.is_dir() and d.name != "_listen")
    print(f"[v3] {len(themes)} Themenordner | HEIC: {'ja' if HEIF_OK else 'NEIN'}")
    print("[v3] Bilder = kuratierte Ordnerbilder, Captions = Trigger + BLIP-Beschreibung (ohne tags)\n")

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    summary: dict[str, dict] = {}
    total = 0

    for theme_dir in themes:
        theme = theme_dir.name
        slug = slugify(theme)
        trigger = f"{TRIGGER_PREFIX}_{slug}"
        caps = read_captions(LISTEN / f"{theme}.csv")

        img_out = OUT / slug / "images"
        img_out.mkdir(parents=True, exist_ok=True)

        files = sorted(p for p in theme_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
        written: list[dict] = []
        rejected: list[dict] = []
        n = 0
        for p in files:
            info = caps.get(p.name)
            if info is None or not info["caption"]:
                rejected.append({"file": p.name, "reason": "keine_beschreibung_in_dieser_themen_csv"})
                continue
            try:
                img = to_rgb(load_image(p))
                w, h = img.size
                if max(w, h) > MAX_SIDE:
                    s = MAX_SIDE / max(w, h)
                    img = img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
                n += 1
                stem = re.sub(r"[^A-Za-z0-9_\-]+", "_", p.stem[:40])
                base = f"{n:02d}_{stem}"
                img.save(img_out / f"{base}.jpg", "JPEG", quality=JPEG_QUALITY, optimize=True)
                (img_out / f"{base}.txt").write_text(f"{trigger}, {info['caption']}\n", encoding="utf-8")
                written.append({"file": p.name, "out": f"{base}.jpg", "aesthetik": info["aesthetik"],
                                "treffer": info["treffer"], "caption": f"{trigger}, {info['caption']}"[:180]})
            except Exception as exc:
                rejected.append({"file": p.name, "reason": f"verarbeitung: {exc}"[:130]})

        man = {
            "theme": theme, "slug": slug, "trigger": trigger,
            "images_written": len(written),
            "caption_rule": "trigger + BLIP-Beschreibung der Zeile DIESES Themas (ohne tags)",
            "rejected": rejected, "written": written,
        }
        (OUT / slug / "manifest.json").write_text(json.dumps(man, ensure_ascii=False, indent=2), encoding="utf-8")
        summary[slug] = {"theme": theme, "trigger": trigger, "written": len(written), "rejected": len(rejected)}
        total += len(written)
        flag = "OK " if len(written) == len(files) else "!! "
        print(f"{flag}{slug:38} {len(written):2d}/{len(files):2d} Bilder")

    (OUT / "_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[v3] FERTIG: {len(summary)} Themen, {total} Bilder -> {OUT}")
    weak = {k: v for k, v in summary.items() if v["written"] < 20}
    if weak:
        print(f"[v3] {len(weak)} Thema(en) unter 20 Bildern:")
        for k, v in weak.items():
            print(f"[v3]   {k}: {v['written']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
