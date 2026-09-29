#!/usr/bin/env python3
"""Holt die Inferenz-Testbilder und baut ein Vergleichsblatt."""
from pathlib import Path

import urllib.request

from PIL import Image, ImageDraw

import r2

BASE = Path(__file__).parent
THEMES = ["taenzer", "krieg_tod", "comic"]
LABELS = ["MIT Trigger: dancer", "MIT Trigger: portrait", "OHNE Trigger: dancer"]
T, L = 400, 26


def main() -> None:
    (BASE / "ergebnisse").mkdir(exist_ok=True)
    c = r2._creds()
    imgs = {}
    for t in THEMES:
        for i in range(len(LABELS)):
            url = r2.presign("GET", f"infer-v2/{t}_{i}.png", **c, expires=900)
            p = Path(f"/tmp/inf_{t}_{i}.png")
            p.write_bytes(urllib.request.urlopen(url, timeout=600).read())
            imgs[(t, i)] = Image.open(p).convert("RGB")

    sheet = Image.new("RGB", (len(LABELS) * T, len(THEMES) * (T + L)), (18, 18, 18))
    d = ImageDraw.Draw(sheet)
    for r, t in enumerate(THEMES):
        for i in range(len(LABELS)):
            im = imgs[(t, i)].copy()
            im.thumbnail((T, T))
            sheet.paste(im, (i * T + (T - im.width) // 2, r * (T + L) + L + (T - im.height) // 2))
        d.text((6, r * (T + L) + 6), f"{t}   |   links: '{LABELS[0]}'   rechts: '{LABELS[1]}'",
               fill=(255, 220, 120))
    out = BASE / "ergebnisse" / "inferenz-test-v2.png"
    sheet.save(out)
    print("Blatt:", out, sheet.size)


if __name__ == "__main__":
    main()
