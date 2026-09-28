#!/usr/bin/env python3
"""Findet je Thema den Schritt, ab dem das LoRA zerfaellt - lokal, kostenlos.

Hintergrund (live belegt, nicht vermutet)
-----------------------------------------
`taenzer`  und `licht_rauch` wurden als Kontrollblatt angesehen: die Serie laeuft
0 -> 200 -> 400 schoen hoch und kippt dann in eine praktisch LEERE Flaeche
(einfarbig beige, Graustufen-Std 0.9 bzw. 5.9). Das ausgelieferte LoRA ist der
800er-Stand - also ist das Ergebnis dieser Themen kaputt.

Die frueher benutzte CLIP-Kennzahl hat das NICHT gesehen: sie stieg bei `taenzer`
sogar am staerksten (+0.288), weil eine leere Flaeche dem Themenzentrum naeher
liegt als ein strukturiertes Bild. Genau diese Verwechslung ist der Grund, warum
hier zwei unabhaengige Groessen gemessen werden:
    Graustufen-Std  -> ist ueberhaupt Struktur da?
    Kantenenergie   -> ist Detail da?
Ein Bild ist erst dann verdaechtig, wenn BEIDE einbrechen.

Der Trainer schreibt die Serie bei jedem save_every selbst - dies kostet also
nichts ausser der Messung.
"""
from __future__ import annotations

import argparse
import io
import json
import re
import tarfile
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

import r2

BASE = Path(__file__).parent
ERGEBNISSE = BASE / "ergebnisse"
SCHRITT_RE = re.compile(r"__(\d{9})_0\.jpg$")

# Ein Bild gilt als zerfallen, wenn es kaum noch Struktur UND kaum noch Kante hat.
# Die Werte sind an den live gesehenen Faellen geeicht (taenzer 0.9/1.7,
# licht_rauch 5.9/--); normale Themen liegen bei Std 25-70.
ZERFALL_STD = 15.0
ZERFALL_KANTE = 8.0


def kennzahlen(img: Image.Image) -> dict:
    g = np.asarray(img.convert("L"), dtype=np.float32)
    kanten = np.asarray(img.convert("L").filter(ImageFilter.FIND_EDGES), dtype=np.float32)
    rgb = np.asarray(img, dtype=np.float32)
    return {"std": round(float(g.std()), 2),
            "kante": round(float(kanten.mean()), 2),
            "farbe": round(float(rgb.reshape(-1, 3).std(axis=0).mean()), 2)}


def serie(theme: str) -> dict[int, Image.Image]:
    c = r2._creds()
    url = r2.presign("GET", f"lora-out/{theme}/samples.tar", **c, expires=3600)
    roh = urllib.request.urlopen(url, timeout=300).read()
    tf = tarfile.open(fileobj=io.BytesIO(roh))
    raus: dict[int, Image.Image] = {}
    for m in tf.getmembers():
        if not m.isfile() or "/.thumbs/" in m.name:
            continue
        mm = SCHRITT_RE.search(m.name)
        if mm:
            raus[int(mm.group(1))] = Image.open(
                io.BytesIO(tf.extractfile(m).read())).convert("RGB")
    return raus


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--themen", default="")
    ap.add_argument("--blätter", action="store_true", help="Kontrollblätter der Verdachtsfälle speichern")
    args = ap.parse_args()

    themen = sorted(p.name for p in (BASE / "out-v3").iterdir()
                    if p.is_dir() and (p / "images").is_dir())
    if args.themen:
        nur = {s.strip() for s in args.themen.split(",")}
        themen = [t for t in themen if t in nur]

    alle: dict[str, dict] = {}
    print(f"{'Thema':34} {'Std je Schritt (0/200/400/600/800)':<44} {'letzter Halt':>12}")
    kaputt: list[str] = []
    for t in themen:
        try:
            bilder = serie(t)
        except Exception as exc:
            print(f"{t:34} FEHLER {exc}")
            continue
        schritte = sorted(bilder)
        werte = {s: kennzahlen(bilder[s]) for s in schritte}
        # letzter Schritt, der NICHT zerfallen ist
        halt = None
        for s in schritte:
            w = werte[s]
            if w["std"] >= ZERFALL_STD and w["kante"] >= ZERFALL_KANTE:
                halt = s
        letzter = schritte[-1]
        wl = werte[letzter]
        zerfallen = wl["std"] < ZERFALL_STD or wl["kante"] < ZERFALL_KANTE
        if zerfallen:
            kaputt.append(t)
        zelle = " ".join(f"{werte[s]['std']:6.1f}" for s in schritte)
        marke = f"{halt}" if halt is not None else "-"
        warn = "  <-- ZERFALL" if zerfallen else ""
        print(f"{t:34} {zelle:<44} {marke:>12}{warn}")
        alle[t] = {"schritte": schritte,
                   "werte": {str(s): werte[s] for s in schritte},
                   "letzter_halt": halt,
                   "letzter_schritt": letzter,
                   "zerfallen": zerfallen}

        if args.blätter and zerfallen:
            b, h = bilder[letzter].size
            halb = (b // 3, h // 3)
            blatt = Image.new("RGB", (halb[0] * len(schritte), halb[1]), "white")
            for i, s in enumerate(schritte):
                blatt.paste(bilder[s].resize(halb), (i * halb[0], 0))
            blatt.save(ERGEBNISSE / f"zerfall-{t}.png")

    print(f"\nZerfallen im letzten Schritt ({len(kaputt)} von {len(alle)}):")
    for t in kaputt:
        a = alle[t]
        print(f"  {t:34} empfohlener Schritt: {a['letzter_halt']}")
    gesund = [t for t in alle if t not in kaputt]
    print(f"\nIn Ordnung im letzten Schritt ({len(gesund)}): {', '.join(gesund) or '-'}")

    ERGEBNISSE.mkdir(exist_ok=True)
    (ERGEBNISSE / "zerfall.json").write_text(
        json.dumps(alle, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Ergebnis: {ERGEBNISSE / 'zerfall.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
