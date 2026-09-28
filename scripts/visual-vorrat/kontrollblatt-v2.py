#!/usr/bin/env python3
"""Kontrollblatt fuer die v2-Datensaetze (ausgewaehlte, eindeutige Bilder)."""
from pathlib import Path

from PIL import Image, ImageDraw

BASE = Path(__file__).parent
OUT = BASE / "out-v2"
THEMES = ["comic", "tattoos_frauen", "natur_tiere", "hdr_sternenhimmel", "kain_plan", "feuer_flammen"]
COLS, THUMB, LABEL = 5, 300, 26


def main() -> None:
    sheet = Image.new("RGB", (COLS * THUMB, len(THEMES) * (THUMB + LABEL)), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    for r, t in enumerate(THEMES):
        files = sorted((OUT / t / "images").glob("*.jpg"))
        for i, f in enumerate(files[:25]):
            im = Image.open(f).convert("RGB")
            im.thumbnail((THUMB, THUMB))
            x = (i % COLS) * THUMB + (THUMB - im.width) // 2
            y = r * (THUMB + LABEL) + LABEL + (THUMB - im.height) // 2
            sheet.paste(im, (x, y))
        d.text((6, r * (THUMB + LABEL) + 6), f"{t}  ({len(files)} Bilder)", fill=(255, 220, 120))
    out = BASE / "pruefung-v2.png"
    sheet.save(out)
    print("Kontrollblatt:", out, sheet.size)

    for t in ["comic", "natur_tiere", "hdr_sternenhimmel"]:
        print(f"\n--- {t} ---")
        for x in sorted((OUT / t / "images").glob("*.txt"))[:2]:
            print("  ", x.read_text().strip()[:200])


if __name__ == "__main__":
    main()
