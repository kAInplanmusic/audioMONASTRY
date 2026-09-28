#!/usr/bin/env python3
"""Sammelt alle Ergebnisse aus R2, baut ein Kontrollblatt und schreibt den Bericht.

Je Thema wird das Probe-Bild des LETZTEN Schritts geholt (das zeigt den fertig
gelernten Stil) und zu einem Blatt zusammengesetzt. Zusaetzlich werden Dauer,
Groesse und Trainer-Exit je Thema aus meta.json gelesen - keine erfundenen Werte.
"""
from __future__ import annotations

import io
import json
import re
import tarfile
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

import r2

BASE = Path(__file__).parent
OUTDIR = BASE / "ergebnisse"
COLS, THUMB, LABEL = 6, 300, 46


def r2_list(prefix: str) -> list[tuple[int, str]]:
    import subprocess

    c = r2._creds()
    cmd = ["rclone", "--config", "/dev/null", "ls", f":s3:{c['bucket']}/{prefix}",
           "--s3-provider", "Cloudflare", "--s3-access-key-id", c["access_key"],
           "--s3-secret-access-key", c["secret_key"], "--s3-endpoint", c["endpoint"]]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    out = []
    for line in res.stdout.splitlines():
        p = line.split(None, 1)
        if len(p) == 2 and p[0].isdigit():
            out.append((int(p[0]), p[1].strip()))
    return out


def fetch(key: str) -> bytes:
    c = r2._creds()
    url = r2.presign("GET", f"lora-out/{key}", **c, expires=3600)
    return urllib.request.urlopen(url, timeout=300).read()


def main() -> int:
    OUTDIR.mkdir(exist_ok=True)
    items = r2_list("lora-out/")
    themes: dict[str, dict] = {}
    for size, key in items:
        if "/" not in key:
            continue
        theme, name = key.split("/", 1)
        themes.setdefault(theme, {})[name] = size

    done = {t: f for t, f in themes.items() if any(k.endswith(".safetensors") for k in f)}
    failed = {t: f for t, f in themes.items() if t not in done and "train.log" in f}
    print(f"LoRAs fertig: {len(done)} | nur Log (Fehlversuch): {len(failed)}")

    rows = []
    for theme in sorted(done):
        info = {"theme": theme,
                "lora_mb": next(v for k, v in done[theme].items() if k.endswith(".safetensors")) / 1e6,
                "has_samples": "samples.tar" in done[theme]}
        try:
            info.update(json.loads(fetch(f"{theme}/meta.json").decode()))
        except Exception as exc:
            info["meta_error"] = str(exc)[:80]
        rows.append(info)

    # Kontrollblatt: letztes Probe-Bild je Thema
    pics: list[tuple[str, Image.Image, str]] = []
    for r in rows:
        theme = r["theme"]
        if not r["has_samples"]:
            continue
        try:
            data = fetch(f"{theme}/samples.tar")
            tf = tarfile.open(fileobj=io.BytesIO(data))
            best, best_step = None, -1
            for m in tf.getmembers():
                if not m.name.endswith(".jpg") or m.name.endswith(".jpg.jpg"):
                    continue
                mm = re.search(r"_(\d{9})_0\.jpg$", m.name)
                if not mm:
                    continue
                step = int(mm.group(1))
                if step > best_step:
                    best_step, best = step, m
            if best is None:
                continue
            img = Image.open(io.BytesIO(tf.extractfile(best).read())).convert("RGB")
            img.thumbnail((THUMB, THUMB))
            pics.append((theme, img, f"Schritt {best_step}"))
        except Exception as exc:
            print(f"  {theme}: Probe-Bild nicht lesbar ({exc})")

    if pics:
        rowsn = (len(pics) + COLS - 1) // COLS
        sheet = Image.new("RGB", (COLS * THUMB, rowsn * (THUMB + LABEL)), (18, 18, 18))
        d = ImageDraw.Draw(sheet)
        for i, (theme, img, note) in enumerate(pics):
            r, c = divmod(i, COLS)
            x = c * THUMB + (THUMB - img.width) // 2
            y = r * (THUMB + LABEL) + LABEL + (THUMB - img.height) // 2
            sheet.paste(img, (x, y))
            d.text((c * THUMB + 6, r * (THUMB + LABEL) + 6), theme[:34], fill=(255, 220, 120))
            d.text((c * THUMB + 6, r * (THUMB + LABEL) + 22), note, fill=(150, 200, 255))
        out = OUTDIR / "alle-themen-loras.png"
        sheet.save(out)
        print(f"Kontrollblatt: {out} ({len(pics)} Themen)")

    (OUTDIR / "ergebnisse.json").write_text(json.dumps(
        {"fertig": rows, "fehlversuche": sorted(failed)}, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n{'Thema':34} {'LoRA':>8} {'Dauer':>8} {'Exit':>5}")
    for r in sorted(rows, key=lambda x: x["theme"]):
        secs = r.get("seconds")
        print(f"{r['theme']:34} {r['lora_mb']:7.1f}M {(str(round(secs/60,1))+' min') if secs else '?':>8} {r.get('trainer_rc','?'):>5}")
    total_min = sum(r.get("seconds", 0) for r in rows) / 60
    print(f"\nSumme Trainingszeit: {total_min:.0f} min = {total_min/60:.2f} h")
    if failed:
        print(f"\nOhne LoRA ({len(failed)}): {', '.join(sorted(failed))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
