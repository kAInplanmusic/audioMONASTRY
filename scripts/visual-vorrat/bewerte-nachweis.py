#!/usr/bin/env python3
"""Wertet die Nachweis-Bilder aus - lokal, kostenlos (CLIP auf der CPU).

Je Thema werden 8 eigene Inferenz-Bilder verglichen: 4 MIT Trigger, 4 OHNE.
Daraus entstehen drei Zahlen, die zusammen etwas belegen:

  struktur      Graustufen-Std und Kantenenergie je Bild. Bricht die Struktur
                ein, ist das LoRA zerfallen (der Fehler, an dem v1 bei 7 von 32
                Themen scheiterte). Vergleichsmass ist NICHT eine feste Zahl,
                sondern der Mittelwert der 25 ECHTEN Bilder des Themas - glatte
                Motive (Haut, Himmel, Makro) haben legitim wenig Struktur.
  spezifitaet   eigen - fremd_max: liegt das Bild naeher am eigenen Thema als an
                jedem der 31 anderen? Gegen die echten Bilder, nicht gegen sich
                selbst (dieser Fehler wurde im ersten Anlauf gemacht).
  kontrast      spezifitaet(MIT Trigger) - spezifitaet(OHNE Trigger). Positiv
                heisst: der Trigger traegt den Stil. Um 0 heisst: das LoRA wirkt
                im Prompt kaum.
"""
from __future__ import annotations

import argparse
import io
import json
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import clipbasis
import r2

BASE = Path(__file__).parent
ERGEBNISSE = BASE / "ergebnisse"
KACHE = ERGEBNISSE / "echt-merkmale.npz"


def holen(schluessel: str) -> bytes:
    c = r2._creds()
    url = r2.presign("GET", schluessel, **c, expires=3600)
    return urllib.request.urlopen(url, timeout=300).read()


def struktur(img: Image.Image) -> tuple[float, float]:
    g = np.asarray(img.convert("L"), dtype=np.float32)
    k = np.asarray(img.convert("L").filter(ImageFilter.FIND_EDGES), dtype=np.float32)
    return float(g.std()), float(k.mean())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="nachweis")
    ap.add_argument("--plan", default="")
    args = ap.parse_args()

    plan_pfad = Path(args.plan) if args.plan else ERGEBNISSE / f"nachweis-plan-{args.tag}.json"
    plan = json.loads(plan_pfad.read_text())
    if not KACHE.exists():
        raise SystemExit(f"Zwischenspeicher fehlt: {KACHE} - erst bewerte.py laufen lassen")
    echt = dict(np.load(KACHE, allow_pickle=True))
    namen = sorted(echt)
    zentren = np.stack([clipbasis.mittelpunkt(echt[t]) for t in namen])

    zeilen = []
    for job in plan["jobs"]:
        t = job["slug"]
        ablage = job["theme"]
        if t not in echt:
            zeilen.append({"theme": t, "status": "kein Referenzzentrum"})
            continue

        bilder, meta = [], []
        for b in job["bilder"]:
            try:
                roh = holen(b["schluessel"])
            except Exception as exc:
                print(f"  {t} {b['schluessel']}: FEHLER {exc}")
                continue
            img = Image.open(io.BytesIO(roh)).convert("RGB")
            bilder.append(img)
            meta.append(b)

        if not bilder:
            zeilen.append({"theme": t, "status": "keine Bilder"})
            continue

        ref_std = float(np.mean([np.asarray(Image.open(BASE / "out-v3" / t / "images" / p.name)
                                 .convert("L"), dtype=np.float32).std()
                                 for p in sorted((BASE / "out-v3" / t / "images").glob("*.jpg"))]))
        emb = clipbasis.merkmale(bilder, still=True)
        idx = namen.index(t)
        werte = []
        for i, e in enumerate(emb):
            std, kante = struktur(bilder[i])
            eigene = clipbasis.mittelpunkt(echt[t])
            eigen = float(clipbasis.kosinus(np.atleast_2d(e),
                                            np.atleast_2d(eigene))[0, 0])
            alle = clipbasis.kosinus(np.atleast_2d(e), zentren)[0]
            fremd = float(np.delete(alle, idx).max())
            werte.append({"schluessel": meta[i]["schluessel"], "art": meta[i]["art"],
                          "prompt_name": meta[i]["prompt_name"],
                          "std": round(std, 2), "kante": round(kante, 2),
                          "eigen": round(eigen, 4), "fremd_max": round(fremd, 4),
                          "spezifitaet": round(eigen - fremd, 4),
                          "leer": bool(std < 0.4 * ref_std)})

        mit = [w for w in werte if w["art"].startswith("mit_")]
        ohne = [w for w in werte if w["art"].startswith("ohne_")]
        m_mit = float(np.mean([w["spezifitaet"] for w in mit])) if mit else float("nan")
        m_ohne = float(np.mean([w["spezifitaet"] for w in ohne])) if ohne else float("nan")
        leer = sum(1 for w in werte if w["leer"])
        # Vielfalt: mittlere paarweise Aehnlichkeit der Trigger-Bilder
        if len(mit) > 1:
            pos = [i for i, w in enumerate(werte) if w["art"].startswith("mit_")]
            m = emb[pos]
            k = clipbasis.kosinus(m, m)
            iu = np.triu_indices(len(m), k=1)
            vielfalt = 1.0 - float(k[iu].mean())
        else:
            vielfalt = float("nan")

        zeilen.append({"theme": t, "referenz_std": round(ref_std, 2),
                       "bilder": werte, "leer": leer, "n": len(werte),
                       "spezifitaet_mit": round(m_mit, 4),
                       "spezifitaet_ohne": round(m_ohne, 4),
                       "trigger_kontrast": round(m_mit - m_ohne, 4),
                       "vielfalt_mit": round(vielfalt, 4)})

    ok = [z for z in zeilen if "trigger_kontrast" in z]
    print(f"{'Thema':32} {'leer':>5} {'mit':>8} {'ohne':>8} {'Kontrast':>9} {'Vielfalt':>9} {'Urteil'}")
    for z in sorted(ok, key=lambda z: z["trigger_kontrast"]):
        urteil = []
        if z["leer"]:
            urteil.append(f"{z['leer']} leer")
        if z["trigger_kontrast"] < 0.01:
            urteil.append("Trigger schwach")
        elif z["trigger_kontrast"] > 0.03:
            urteil.append("Trigger traegt")
        print(f"{z['theme']:32} {z['leer']:5d} {z['spezifitaet_mit']:8.3f} "
              f"{z['spezifitaet_ohne']:8.3f} {z['trigger_kontrast']:9.3f} "
              f"{z['vielfalt_mit']:9.3f} {', '.join(urteil) or 'ok'}")

    if ok:
        k = np.array([z["trigger_kontrast"] for z in ok])
        l = np.array([z["leer"] for z in ok])
        print(f"\n{len(ok)} Themen · Trigger-Kontrast min {k.min():+.3f} / "
              f"median {np.median(k):+.3f} / max {k.max():+.3f}")
        print(f"Bilder mit eingebrochener Struktur: {int(l.sum())} von "
              f"{sum(z['n'] for z in ok)}")
        print("Deutung: Kontrast > 0 heisst, dass derselbe Prompt MIT Trigger "
              "naeher am Thema landet als ohne.")

    (ERGEBNISSE / f"nachweis-{args.tag}.json").write_text(
        json.dumps(zeilen, ensure_ascii=False, indent=2), encoding="utf-8")

    # Kontrollblatt: je Thema eine Zeile (MIT links, OHNE rechts)
    if ok:
        kachel = (256, 256)
        blatt = Image.new("RGB", (kachel[0] * 8, kachel[1] * len(ok) + 20 * len(ok)), "white")
        d = ImageDraw.Draw(blatt)
        for r, z in enumerate(sorted(ok, key=lambda z: z["theme"])):
            y = r * (kachel[1] + 20)
            d.text((4, y + 5), f"{z['theme']}   links MIT Trigger / rechts OHNE   "
                               f"Kontrast {z['trigger_kontrast']:+.3f}   leer {z['leer']}",
                   fill="black")
            for c, w in enumerate(z["bilder"][:8]):
                try:
                    img = Image.open(io.BytesIO(holen(w["schluessel"]))).convert("RGB").resize(kachel)
                    blatt.paste(img, (c * kachel[0], y + 20))
                except Exception:
                    pass
        blatt.save(ERGEBNISSE / f"nachweis-{args.tag}.png")
        print(f"Kontrollblatt: {ERGEBNISSE / f'nachweis-{args.tag}.png'}")
    print(f"Messwerte: {ERGEBNISSE / f'nachweis-{args.tag}.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
