#!/usr/bin/env python3
"""Kontrollblatt + Caption-Stichproben fuer die gebauten Datensaetze."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "out"
THEMES = ["comic", "natur_tiere", "gewitter_raining_day", "tattoos_frauen"]
COLS, THUMB, LABEL = 5, 300, 26


def main() -> None:
    sheet = Image.new("RGB", (COLS * THUMB, len(THEMES) * (THUMB + LABEL)), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    for r, t in enumerate(THEMES):
        files = sorted((OUT / t / "images").glob("*.jpg"))[:25]
        for i, f in enumerate(files):
            im = Image.open(f).convert("RGB")
            im.thumbnail((THUMB, THUMB))
            x = (i % COLS) * THUMB + (THUMB - im.width) // 2
            y = r * (THUMB + LABEL) + LABEL + (THUMB - im.height) // 2
            sheet.paste(im, (x, y))
        d.text((6, r * (THUMB + LABEL) + 6), f"{t}  ({len(files)} Bilder)", fill=(255, 220, 120))
    out = Path(__file__).parent / "pruefung-datensaetze.png"
    sheet.save(out)
    print("Kontrollblatt:", out, sheet.size)

    for t in ["comic", "natur_tiere", "vorsintflutliche_hochkultur", "nackte_haut"]:
        print(f"\n--- {t} ---")
        for x in sorted((OUT / t / "images").glob("*.txt"))[:2]:
            print(" ", x.name, "->", x.read_text().strip()[:230])


if __name__ == "__main__":
    main()
