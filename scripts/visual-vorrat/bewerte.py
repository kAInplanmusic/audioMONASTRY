#!/usr/bin/env python3
"""Bewertet Themen-LoRAs lokal und kostenlos - mit CLIP auf der CPU.

Die Metrik (alle drei werden gebraucht, keine allein beweist etwas)
------------------------------------------------------------------
  eigen        mittlerer Kosinus eines Bildes zum Zentrum der 25 ECHTEN Themenbilder
  fremd_max    der hoechste Kosinus zu einem der 31 ANDEREN Themenzentren
  spezifitaet  eigen - fremd_max
               > 0 heisst: das Bild landet naeher am eigenen Thema als an jedem
               fremden Thema. Das ist die belastbare Frage ("drueckt das LoRA
               DIESES Thema aus?") und sie ist vergleichbar ueber alle 32 Themen.

Der Trainer schreibt je Thema eine Serie 0/200/400/600/800 (konstanter Prompt,
gleicher Seed). Schritt 0 ist der Basiswert OHNE wirksames LoRA. Damit laesst
sich die Konvergenz Frage beantworten, die vorher offen blieb: ist bei 800
Schritten noch Luft (Kurve steigt) oder ist der Punkt schon ueberschritten
(Kurve faellt)?

Bekannte Grenze, ehrlich benannt
--------------------------------
Die Probe-Bilder zeigen einen fremden Inhalt (Taenzer/Portraet) im Themenstil.
Inhalt und Stil sind in CLIP nicht vollstaendig trennbar. Deshalb traegt die
absolute Zahl 'eigen' wenig, aber der VERGLEICH (ueber Schritte, ueber Themen,
und 'spezifitaet' gegen die 31 fremden Themen) traegt.
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
from PIL import Image

import clipbasis
import r2

BASE = Path(__file__).parent
ERGEBNISSE = BASE / "ergebnisse"
CACHE = ERGEBNISSE / "echt-merkmale.npz"
SCHRITT_RE = re.compile(r"__(\d{9})_0\.jpg$")


def themen() -> list[str]:
    return sorted(p.name for p in (BASE / "out-v3").iterdir()
                  if p.is_dir() and (p / "images").is_dir())


# --- echte Bilder einmal einbetten und zwischenspeichern ---------------------
def cache_bauen(themen_liste: list[str], erneut: bool = False) -> dict:
    if CACHE.exists() and not erneut:
        d = np.load(CACHE, allow_pickle=True)
        return {k: d[k] for k in d.files}

    daten: dict[str, np.ndarray] = {}
    for i, t in enumerate(themen_liste, 1):
        bilder = sorted((BASE / "out-v3" / t / "images").glob("*.jpg"))
        print(f"[{i}/{len(themen_liste)}] {t}: {len(bilder)} echte Bilder", flush=True)
        m = clipbasis.merkmale([Image.open(b) for b in bilder], still=True)
        daten[t] = m
    ERGEBNISSE.mkdir(exist_ok=True)
    np.savez_compressed(CACHE, **daten)
    print(f"Zwischenspeicher: {CACHE}")
    return daten


def zentren(echt: dict) -> tuple[dict, np.ndarray]:
    """Zentrum je Thema -> dict und Matrix [n_themen, 512]."""
    z = {t: clipbasis.mittelpunkt(m) for t, m in echt.items()}
    namen = sorted(z)
    return z, np.stack([z[t] for t in namen])


def spezifitaet(probe: np.ndarray, eigene: np.ndarray,
                fremdmatrix: np.ndarray, index: int) -> dict:
    """Kennzahlen eines Probe-Bildes gegen sein eigenes und alle fremden Zentren.

    probe/eigene duerfen 1-D (ein Vektor) oder 2-D (ein Stapel) sein - beides
    kommt vor: die Zentrums-Pruefung schickt einen Vektor, die Serien-Pruefung
    einen Stapel je Schritt.
    """
    p = np.atleast_2d(np.asarray(probe, dtype=np.float32))
    e = np.atleast_2d(np.asarray(eigene, dtype=np.float32))
    eigen = float(clipbasis.kosinus(p, e)[0, 0])
    alle = clipbasis.kosinus(p, fremdmatrix)[0]
    fremd = np.delete(alle, index)
    return {"eigen": round(eigen, 4),
            "fremd_max": round(float(fremd.max()), 4),
            "fremd_mittel": round(float(fremd.mean()), 4),
            "spezifitaet": round(eigen - float(fremd.max()), 4)}


# --- Serie aus R2 ------------------------------------------------------------
def serie_holen(theme: str) -> dict[int, Image.Image]:
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
            raus[int(mm.group(1))] = Image.open(io.BytesIO(tf.extractfile(m).read())).convert("RGB")
    return raus


def loo_reinheit(echt, z, themenliste) -> list[dict]:
    """Leave-one-out: jedes Bild wird gegen das Zentrum seines EIGENEN Themas
    geprueft, das OHNE dieses Bild gebildet wurde.

    Warum das noetig ist: im ersten Anlauf habe ich jedes Bild gegen das volle
    eigene Zentrum gemessen - das Bild steckte also in seiner eigenen Referenz
    und 'eigen' war immer 1.000. Die Zahl war damit wertlos (derselbe Fehlertyp
    wie beim Probe-Bild: eine Kennzahl, die die Frage nicht stellt).

    Rueckgabe je Bild: eigen, fremd_max, naeher_bei, rein.
    """
    namen = sorted(z)
    rows: list[dict] = []
    for t in themenliste:
        e = echt[t]
        n = len(e)
        if n < 2:
            continue
        summe = e.sum(axis=0)
        fremd_namen = [o for o in namen if o != t]
        fremd_zentren = np.stack([z[o] for o in fremd_namen])
        for i in range(n):
            zentrum = summe - e[i]                 # eigenes Zentrum OHNE Bild i
            norm = float(np.linalg.norm(zentrum))
            if norm < 1e-8:
                continue
            zentrum = zentrum / norm
            eigen = float(np.dot(e[i], zentrum))
            fremd = clipbasis.kosinus(e[i:i + 1], fremd_zentren)[0]
            j = int(fremd.argmax())
            rows.append({"theme": t, "pos": i,
                         "eigen": round(eigen, 4),
                         "fremd_max": round(float(fremd[j]), 4),
                         "naeher_bei": fremd_namen[j],
                         "rein": bool(eigen > fremd[j])})
    return rows


def daten_pruefung(liste, echt, z, matrix, index) -> int:
    """Wie themenrein sind die 25 Trainingsbilder je Thema? Ein Bild, das naeher
    an einem anderen Thema liegt, traegt dessen Stil in den eigenen Trainingssatz.
    Die Pruefung kostet nichts und zeigt, welche Themen verwaschenes Material haben.
    """
    rows = loo_reinheit(echt, z, liste)
    je: dict[str, list[dict]] = {}
    for r in rows:
        je.setdefault(r["theme"], []).append(r)

    print(f"{'Thema':34} {'rein':>7}  Ausreisser (naeher bei ...)")
    auf = []
    for t in sorted(je):
        rs = je[t]
        rein = sum(1 for r in rs if r["rein"])
        raus = sorted((r for r in rs if not r["rein"]),
                      key=lambda r: r["eigen"] - r["fremd_max"])
        text = ", ".join(f"{r['naeher_bei']} ({r['eigen'] - r['fremd_max']:+.3f})"
                         for r in raus[:4])
        if len(raus) > 4:
            text += f" ... +{len(raus) - 4}"
        print(f"{t:34} {rein:4d}/{len(rs):<2d}  {text}")
        auf.append({"theme": t, "rein": rein, "gesamt": len(rs),
                    "ausreisser": [{"naeher_bei": r["naeher_bei"],
                                    "abstand": round(r["eigen"] - r["fremd_max"], 4)}
                                   for r in raus]})

    ges = sum(a["rein"] for a in auf)
    tot = sum(a["gesamt"] for a in auf)
    print(f"\nLeave-one-out: {ges} von {tot} Trainingsbildern "
          f"({100 * ges / max(tot, 1):.1f} %) liegen beim EIGENEN Thema")
    print("Schwaechste Themen (unreinstes Material):")
    for a in sorted(auf, key=lambda x: x["rein"])[:8]:
        print(f"  {a['theme']:34} {a['rein']:3d}/{a['gesamt']}")
    (ERGEBNISSE / "daten-reinheit.json").write_text(
        json.dumps({"je_thema": auf, "bilder": rows}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"Ergebnis: {ERGEBNISSE / 'daten-reinheit.json'}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serie", action="store_true", help="Probe-Serie aus R2 auswerten")
    ap.add_argument("--daten", action="store_true",
                    help="Themenreinheit der Trainingsbilder pruefen (kostenlos)")
    ap.add_argument("--themen", default="", help="kommagetrennt, Standard: alle")
    ap.add_argument("--cache-neu", action="store_true")
    args = ap.parse_args()

    liste = themen()
    echt = cache_bauen(liste, erneut=args.cache_neu)
    z, matrix = zentren(echt)
    namen = sorted(z)
    index = {t: i for i, t in enumerate(namen)}

    if args.themen:
        liste = [t for t in liste if t in {s.strip() for s in args.themen.split(",")}]

    if args.daten:
        return daten_pruefung(liste, echt, z, matrix, index)

    if not args.serie:
        # Wie trennbar sind die 32 Themen ueberhaupt? Leave-one-out, damit sich kein
        # Bild in seiner eigenen Referenz wiederfindet (der Fehler des ersten
        # Anlaufs: 'eigen' war immer 1.000). Das ist die OBERGRENZE dafuer, was
        # ein LoRA ueberhaupt treffen kann.
        rows = loo_reinheit(echt, z, liste)
        ges = sum(1 for r in rows if r["rein"])
        rand = np.array([r["eigen"] - r["fremd_max"] for r in rows])
        je: dict[str, list] = {}
        for r in rows:
            je.setdefault(r["theme"], []).append(r["rein"])
        print(f"Leave-one-out ueber {len(rows)} Trainingsbilder, {len(je)} Themen:")
        print(f"  richtig beim eigenen Thema: {ges}/{len(rows)} "
              f"({100 * ges / max(len(rows), 1):.1f} %)")
        print(f"  Rand (eigen - fremd_max): min {rand.min():+.3f} / "
              f"median {np.median(rand):+.3f} / max {rand.max():+.3f}")
        print("  schwaechste Themen (Bilder mit fremdem Thema):")
        for t, treffer in sorted(je.items(), key=lambda kv: sum(kv[1]))[:6]:
            print(f"    {t:34} {sum(treffer)}/{len(treffer)}")
        print(f"\nZufall waere 1/{len(je)}. Ein hoher Wert heisst nur: die QUELLBILDER sind")
        print("trennbar - nicht, dass das LoRA es trifft. Dafuer: --daten / --serie.")
        (ERGEBNISSE / "themen-trennbarkeit.json").write_text(
            json.dumps({"bilder": len(rows), "richtig": ges,
                        "rand_median": float(np.median(rand)),
                        "je_thema": {t: f"{sum(v)}/{len(v)}" for t, v in je.items()}},
                       ensure_ascii=False, indent=2), encoding="utf-8")
        return 0

    # --- Serie je Thema ------------------------------------------------------
    print(f"\n{'Thema':32} {'S0':>7} {'S200':>7} {'S400':>7} {'S600':>7} {'S800':>7} "
          f"{'800-0':>7} {'Trend':>7}")
    rows = []
    for i, t in enumerate(liste, 1):
        try:
            serie = serie_holen(t)
        except Exception as exc:
            print(f"{t:32} FEHLER {exc}")
            rows.append({"theme": t, "status": f"fehler: {exc}"})
            continue
        schritte = sorted(serie)
        if not schritte:
            rows.append({"theme": t, "status": "keine probebilder"})
            continue
        emb = clipbasis.merkmale([serie[s] for s in schritte], still=True)
        werte = {}
        for s, e in zip(schritte, emb):
            werte[s] = spezifitaet(e, z[t], matrix, index[t])
        eig = [werte[s]["eigen"] for s in schritte]
        # Trend = Steigung der linearen Anpassung ueber die Schritte
        x = np.array(schritte, dtype=np.float32)
        steigung = float(np.polyfit(x, np.array(eig), 1)[0]) if len(schritte) > 1 else float("nan")
        trend = "steigt" if steigung > 1e-5 else ("faellt" if steigung < -1e-5 else "flach")
        zell = " ".join(f"{werte[s]['eigen']:7.3f}" for s in schritte)
        print(f"{t:32} {zell} {werte[schritte[-1]]['eigen'] - werte[schritte[0]]['eigen']:7.3f} {trend:>7}")
        rows.append({"theme": t,
                     "schritte": schritte,
                     "eigen": [round(werte[s]["eigen"], 4) for s in schritte],
                     "spezifitaet": [round(werte[s]["spezifitaet"], 4) for s in schritte],
                     "steigung_je_schritt": round(steigung, 8),
                     "trend": trend})

    (ERGEBNISSE / "bewertung-serie.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    ok = [r for r in rows if "trend" in r]
    steigt = [r for r in ok if r["trend"] == "steigt"]
    faellt = [r for r in ok if r["trend"] == "faellt"]
    print(f"\nAusgewertet: {len(ok)} Themen")
    print(f"  noch steigend bei 800 (mehr Schritte koennten helfen): {len(steigt)}")
    print(f"  schon fallend bei 800 (ueber den Punkt hinaus):        {len(faellt)}")
    if steigt:
        print("  steigend: " + ", ".join(r["theme"] for r in steigt))
    if faellt:
        print("  fallend:  " + ", ".join(r["theme"] for r in faellt))
    print(f"Ergebnis: {ERGEBNISSE / 'bewertung-serie.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
