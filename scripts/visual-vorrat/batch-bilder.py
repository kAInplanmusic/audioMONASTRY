#!/usr/bin/env python3
"""Bilder im Voraus erzeugen, damit der Visualizer aus einem Vorrat waehlt.

Warum als Batch
---------------
Gemessen: 13 min Kaltstart gegen 12 s pro Bild im warmen Worker. Tausend
Einzelaufrufe sind tausend Kaltstarts und kosten ein Vielfaches. Ein warmes
Fenster hat genau einen. Deshalb laufen die Auftraege **hintereinander in einer
Sitzung**, nicht verstreut.

Wiederaufsetzbar
----------------
Was in --out schon liegt, wird uebersprungen. Eine lange Sitzung ueberlebt keinen
Absturz garantiert — doppelt bezahlte Bilder sind der Fehler, den dieses Skript
verhindert. Der Fortschritt steht in manifest.jsonl, eine Zeile je Bild.

Zwei Vorkehrungen dafuer, beide noetig:
  * Die Kennung eines Auftrags wird aus einem stabilen Streuwert gebildet
    (sha1), NICHT aus hash(): Python salzt Zeichenketten je Prozess, ein
    Neustart faende die vorhandenen Dateien sonst nicht wieder.
  * Uebersprungen wird zusaetzlich ueber manifest.jsonl, und zwar nach der
    Bestellung (kombo, motiv, seed) statt nach dem Dateinamen. Bilder aus der
    Zeit vor der stabilen Kennung werden so ebenfalls nicht ein zweites Mal
    bezahlt.

Aufruf
------
    python3 batch-bilder.py --limit 16  --out bilder-pilot     # Trockenlauf
    python3 batch-bilder.py --limit 3400 --out bilder-vorrat   # grosse Runde
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import itertools
import json
import pathlib
import time
import urllib.error
import urllib.request

# --- Adapter laden: er baut die Graphen, hier wird nichts nachgebaut -------------
_ADAPTER = pathlib.Path(
    "/home/patrick/AnunnakiTools Projekte/laufende Projekte/audioMONASTRY"
    "/services/audiomonastry-ai-runtime/comfyui_adapter.py"
)
_spec = importlib.util.spec_from_file_location("comfyui_adapter", _ADAPTER)
if _spec is None or _spec.loader is None:
    raise SystemExit(f"Adapter nicht gefunden: {_ADAPTER}")
adapter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(adapter)

# --- Die Kombinationen ----------------------------------------------------------
# Basismodell beachten: fremd_cbrpnk, fremd_flame_fractal und fremd_fractal_aliens
# sind auf FLUX.1-dev trainiert und laufen NICHT im SDXL-Graph. Die uebrigen acht
# fremden und alle 32 eigenen Themen sind SDXL.
SDXL = "sdxl"
FLUX = "flux1"

KOMBIS: list[tuple[str, str, list[dict]]] = [
    ("psy_techno   ", SDXL, [{"name": "fremd_psychemelt.safetensors", "weight": 0.65},
                             {"name": "fremd_surreal_collage.safetensors", "weight": 0.35},
                             {"name": "fremd_glowing.safetensors", "weight": 0.25}]),
    ("dark_techno  ", SDXL, [{"name": "dark_ornament.safetensors", "weight": 0.55},
                             {"name": "fremd_chrome.safetensors", "weight": 0.45},
                             {"name": "fremd_glowing.safetensors", "weight": 0.25}]),
    ("alien_techno ", SDXL, [{"name": "fremd_giger.safetensors", "weight": 0.55},
                             {"name": "fremd_surreal_harmony.safetensors", "weight": 0.35},
                             {"name": "fremd_chrome.safetensors", "weight": 0.30}]),
    ("metal_flow   ", SDXL, [{"name": "fremd_chrome.safetensors", "weight": 0.60},
                             {"name": "fremd_surreal_harmony.safetensors", "weight": 0.30}]),
    ("vhs_night    ", SDXL, [{"name": "fremd_vhs.safetensors", "weight": 0.55},
                             {"name": "fremd_giger.safetensors", "weight": 0.30},
                             {"name": "fremd_glowing.safetensors", "weight": 0.20}]),
    ("eskalation   ", SDXL, [{"name": "fremd_trip_slider.safetensors", "weight": 0.70},
                             {"name": "fremd_giger.safetensors", "weight": 0.40},
                             {"name": "fremd_chrome.safetensors", "weight": 0.30},
                             {"name": "fremd_glowing.safetensors", "weight": 0.20}]),
    ("feuer_organik", SDXL, [{"name": "feuer_flammen.safetensors", "weight": 0.50},
                             {"name": "fremd_giger.safetensors", "weight": 0.40}]),
    ("traumraum    ", SDXL, [{"name": "fremd_surreal_collage.safetensors", "weight": 0.55},
                             {"name": "fremd_surreal_harmony.safetensors", "weight": 0.45},
                             {"name": "fremd_psychemelt.safetensors", "weight": 0.30}]),
    ("flux_alien   ", FLUX, [{"name": "fremd_fractal_aliens.safetensors", "weight": 0.40},
                             {"name": "fremd_cbrpnk.safetensors", "weight": 0.35}]),
    ("flux_flame   ", FLUX, [{"name": "fremd_flame_fractal.safetensors", "weight": 0.60},
                             {"name": "fremd_cbrpnk.safetensors", "weight": 0.30}]),
    ("flux_trip    ", FLUX, [{"name": "fremd_cbrpnk.safetensors", "weight": 0.70},
                             {"name": "fremd_flame_fractal.safetensors", "weight": 0.35}]),
    # --- nachgeladen 28.09.: fertige FLUX-LoRAs zu den SDXL-Themen --------------
    # Die Qualitaet dieser sieben ist NICHT geprueft (fast alle von einem
    # Massen-Uploader). Der naechste Lauf ist auch ihre Pruefung.
    ("flux_giger    ", FLUX, [{"name": "fremd_flux_giger.safetensors", "weight": 0.55},
                              {"name": "fremd_flux_chrome.safetensors", "weight": 0.45}]),
    ("flux_psy_geo  ", FLUX, [{"name": "fremd_flux_psychedelic.safetensors", "weight": 0.60},
                              {"name": "fremd_flux_fractal_geo.safetensors", "weight": 0.40}]),
    ("flux_cyber    ", FLUX, [{"name": "fremd_flux_cyberpunk.safetensors", "weight": 0.55},
                              {"name": "fremd_flux_chrome.safetensors", "weight": 0.35},
                              {"name": "fremd_flux_psychedelic.safetensors", "weight": 0.25}]),
    ("flux_dream    ", FLUX, [{"name": "fremd_flux_dreamlike.safetensors", "weight": 0.50},
                              {"name": "fremd_flux_fractal_psy.safetensors", "weight": 0.40}]),
    ("flux_voll     ", FLUX, [{"name": "fremd_flux_giger.safetensors", "weight": 0.40},
                              {"name": "fremd_flux_chrome.safetensors", "weight": 0.30},
                              {"name": "fremd_flux_psychedelic.safetensors", "weight": 0.30}]),
]

# Neutrale Motive: die LoRA soll den Stil liefern, nicht das Motiv.
MOTIVE = [
    "a lone figure on a neon-lit stage, cinematic light",
    "a biomechanical alien temple, dark, immense scale",
    "a giant alien flower on a black background",
    "an endless corridor of machines, fog",
    "floating geometry in an empty void",
    "a cathedral of light, impossible architecture",
    "a slow-flowing metal landscape at night",
    "an organic machine breathing in the dark",
    "a face dissolving into liquid chrome",
    "a vast structure of bone and steel",
]

# Mehr Seeds, weil 8+8 Kombinationen x 10 Motive x 2 Seeds nur 320 verschiedene
# Bilder ergeben — fuer 2000 braucht es mehr Varianz pro Motiv.
SEEDS = [4711, 20260927, 1977, 2049, 31415, 987654, 112358, 55555,
         88, 4242, 9001, 66613, 20250101]


def auftraege(limit: int, gruppe: bool = False):
    """Auftragsliste: Kombination x Motiv x Seed — deterministisch, damit ein
    zweiter Lauf genau dieselben Bilder ergaenzt statt andere zu erzeugen.

    Zwei Ordnungen, beide begruendet:
      gruppe=True  — Kombination aussen. Aufeinanderfolgende Bilder nutzen dieselben
                     LoRAs, ComfyUI laedt sie einmal statt bei jedem Bild. Das ist
                     die Sparschraube im grossen Lauf: gemessen 30 s je Bild im
                     Wechsel, und ein Teil davon ist reines Nachladen.
      gruppe=False — Kombination innen. Ein kleiner --limit deckt zuerst ALLE
                     Kombinationen ab — richtig fuer einen Pilotlauf.
    """
    if gruppe:
        folge = [(kombo, basis, loras, motiv, seed)
                 for kombo, basis, loras in KOMBIS
                 for motiv, seed in itertools.product(MOTIVE, SEEDS)]
    else:
        folge = [(kombo, basis, loras, motiv, seed)
                 for seed, motiv, (kombo, basis, loras) in itertools.product(SEEDS, MOTIVE, KOMBIS)]

    alle = []
    for kombo, basis, loras, motiv, seed in folge:
        alle.append({"kennung": kennung_von(kombo, motiv, seed), "kombo": kombo.strip(),
                     "basis": basis, "loras": loras, "motiv": motiv, "seed": seed})
    return alle[:limit] if limit else alle


def kennung_von(kombo: str, motiv: str, seed: int) -> str:
    """Dateiname einer Bestellung — stabil ueber Prozessgrenzen hinweg.

    hash((kombo, motiv, seed)) waere hier falsch: Python salzt Zeichenketten je
    Prozess (PYTHONHASHSEED), ein Wiederaufnahme-Lauf berechnet fuer dieselbe
    Bestellung also einen anderen Namen, findet die vorhandene Datei nicht und
    bezahlt alles ein zweites Mal. Gemessen: derselbe Auftrag ergab in zwei
    Prozessen 25563211 und 72407584.
    """
    roh = f"{kombo.strip()}|{motiv}|{seed}".encode()
    return f"{kombo.strip()}__{int(hashlib.sha1(roh).hexdigest(), 16) % 10**10:010d}"


def schon_erzeugt(manifest: pathlib.Path) -> set[tuple[str, str, int]]:
    """Bereits erzeugte Bestellungen aus manifest.jsonl.

    Schluessel ist die Bestellung selbst, nicht der Dateiname: Bilder aus der
    Zeit vor der stabilen Kennung liegen unter einem Namen, den niemand mehr
    ausrechnen kann — ueber das Manifest werden sie trotzdem erkannt."""
    fertig: set[tuple[str, str, int]] = set()
    if not manifest.exists():
        return fertig
    for zeile in manifest.read_text(errors="replace").splitlines():
        try:
            satz = json.loads(zeile)
            fertig.add((str(satz["kombo"]), str(satz["motiv"]), int(satz["seed"])))
        except (ValueError, KeyError, TypeError):
            continue  # halb geschriebene Zeile nach Absturz: nicht als fertig zaehlen
    return fertig


def runpod_key() -> str:
    import os
    import re
    if os.environ.get("RUNPOD_API_KEY"):
        return os.environ["RUNPOD_API_KEY"]
    env = pathlib.Path("/home/patrick/AnunnakiTools Projekte/laufende Projekte/audioMONASTRY/.env")
    for zeile in env.read_text(errors="replace").splitlines():
        if zeile.startswith("RP_API_KEY="):
            return re.sub(r'^["\']|["\']$', "", zeile.split("=", 1)[1].strip())
    raise SystemExit("kein RUNPOD_API_KEY / RP_API_KEY gefunden")


def bild_holen(endpoint: str, key: str, auftrag: dict, timeout: int) -> tuple[bytes | None, float, str]:
    """Einen Auftrag abschicken und das Bild zurueckholen. Gibt (PNG, Dauer, Hinweis)."""
    payload = adapter.build_request(
        "image.lora", "imageLora", "image-lora-stack",
        {"prompt": auftrag["motiv"], "seed": auftrag["seed"], "base": auftrag["basis"],
         "lora_pairs": auftrag["loras"]},
    )
    # Die RunPod-API erwartet den Handler-Input unter "input". Ohne diese Huelle
    # antwortet der Worker mit "Job has missing field(s): id or input" — der Job
    # kommt nie an, und der Kaltstart ist trotzdem bezahlt. runpodctl verpackt das
    # bei den Smoke-Tests selbst, hier muss es das Skript tun.
    daten = json.dumps({"input": payload}).encode()
    anfrage = urllib.request.Request(
        f"https://api.runpod.ai/v2/{endpoint}/runsync",
        data=daten,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(anfrage, timeout=timeout) as antwort:
            ergebnis = json.load(antwort)
    except urllib.error.HTTPError as exc:
        return None, time.time() - start, f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return None, time.time() - start, f"netz: {exc}"

    status = str(ergebnis.get("status", "")).upper()
    if status != "COMPLETED":
        # Ein kalter Worker antwortet mit IN_QUEUE/IN_PROGRESS — dann warten.
        kennung = ergebnis.get("id")
        if status in ("IN_QUEUE", "IN_PROGRESS") and kennung:
            return _warten(endpoint, key, kennung, timeout)
        return None, time.time() - start, f"status {status}"
    return _bild_aus(ergebnis), time.time() - start, "ok"


def _warten(endpoint: str, key: str, kennung: str, timeout: int):
    """Kaltstart abwarten — 13 min gemessen, deshalb grosszuegig."""
    start = time.time()
    frist = start + timeout
    while time.time() < frist:
        time.sleep(5)
        anfrage = urllib.request.Request(
            f"https://api.runpod.ai/v2/{endpoint}/status/{kennung}",
            headers={"Authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(anfrage, timeout=60) as antwort:
                ergebnis = json.load(antwort)
        except Exception:  # noqa: BLE001
            continue
        status = str(ergebnis.get("status", "")).upper()
        if status == "COMPLETED":
            return _bild_aus(ergebnis), time.time() - start, "ok (nach Kaltstart)"
        if status in ("FAILED", "CANCELLED", "TIMED_OUT"):
            return None, time.time() - start, f"status {status}"
    return None, time.time() - start, "Frist ueberschritten"


def _bild_aus(ergebnis: dict) -> bytes | None:
    ausgabe = ergebnis.get("output") or {}
    bilder = ausgabe.get("images") if isinstance(ausgabe, dict) else None
    if not bilder:
        return None
    roh = bilder[0].get("data", "") if isinstance(bilder[0], dict) else ""
    if not roh:
        return None
    return base64.b64decode(roh.split(",", 1)[1] if roh.startswith("data:") else roh)


def main() -> int:
    parser = argparse.ArgumentParser(description="Bilder im Voraus erzeugen")
    parser.add_argument("--endpoint", default="wzh9hcbitjnn95")
    parser.add_argument("--out", default="bilder-vorrat")
    parser.add_argument("--limit", type=int, default=16, help="0 = alle")
    parser.add_argument("--timeout", type=int, default=1200, help="je Auftrag, inkl. Kaltstart")
    parser.add_argument("--pause", type=float, default=0.0, help="Sekunden zwischen Auftraegen")
    parser.add_argument("--kombo", default="",
                        help="nur diese Kombination(en), kommagetrennt (z. B. flux_alien)")
    parser.add_argument("--gruppe", action="store_true",
                        help="nach Kombination gruppieren: laedt die LoRAs einmal statt je Bild")
    args = parser.parse_args()

    ziel = pathlib.Path(args.out)
    ziel.mkdir(parents=True, exist_ok=True)
    manifest = ziel / "manifest.jsonl"
    key = runpod_key()

    # Reihenfolge ist wichtig: erst filtern, DANN kuerzen. Umgekehrt schneidet
    # --limit die ersten N ab, und eine spaetere Kombination hat keine Auftraege
    # mehr — genau das ist beim ersten Versuch passiert.
    liste = auftraege(0, gruppe=args.gruppe)
    if args.kombo:
        # Eine einzelne Kombination messen oder nachfahren. Mit --gruppe ist das
        # der saubere Weg, die Zeit je Bild OHNE LoRA-Nachladen zu bestimmen.
        gesucht = [k.strip().lower() for k in args.kombo.split(",")]
        liste = [a for a in liste if a["kombo"].lower() in gesucht]
        if not liste:
            raise SystemExit(f"keine Auftraege fuer --kombo {args.kombo}")
    if args.limit:
        liste = liste[:args.limit]
    print(f"Auftraege: {len(liste)} | Ausgabe: {ziel}/ | Endpoint: {args.endpoint}")
    print(f"Kombinationen: {len({a['kombo'] for a in liste})}, "
          f"SDXL {sum(1 for a in liste if a['basis'] == SDXL)}, FLUX {sum(1 for a in liste if a['basis'] == FLUX)}")

    fertig = fehler = uebersprungen = 0
    gesamtzeit = 0.0
    erledigt = schon_erzeugt(manifest)
    if erledigt:
        print(f"Laut manifest.jsonl bereits erzeugt: {len(erledigt)} Bestellungen "
              f"— werden uebersprungen")
    for nummer, auftrag in enumerate(liste, 1):
        datei = ziel / f"{auftrag['kennung']}.png"
        bestellung = (auftrag["kombo"], auftrag["motiv"], auftrag["seed"])
        if datei.exists() or bestellung in erledigt:
            uebersprungen += 1
            continue
        png, dauer, hinweis = bild_holen(args.endpoint, key, auftrag, args.timeout)
        gesamtzeit += dauer
        if png:
            datei.write_bytes(png)
            fertig += 1
            with manifest.open("a") as fh:
                fh.write(json.dumps({**auftrag, "datei": datei.name, "bytes": len(png),
                                     "sekunden": round(dauer, 1), "hinweis": hinweis}) + "\n")
            print(f"[{nummer}/{len(liste)}] {auftrag['kombo']:14} {auftrag['basis']:5} "
                  f"seed {auftrag['seed']:<9} {len(png):>9} B  {dauer:5.1f}s  {hinweis}")
        else:
            fehler += 1
            print(f"[{nummer}/{len(liste)}] {auftrag['kombo']:14} FEHLER: {hinweis} ({dauer:.1f}s)")
        if args.pause:
            time.sleep(args.pause)

    print(f"\nFERTIG: {fertig} neu, {uebersprungen} uebersprungen, {fehler} Fehler")
    if fertig:
        print(f"Zeit fuer die neuen Bilder: {gesamtzeit / 60:.1f} min "
              f"({gesamtzeit / fertig:.1f} s je Bild)")
        # 0,44 USD/h ist der gemessene Satz, nicht der Listenpreis der Karte.
        print(f"Kosten dieser Runde (gemessener Satz 0,44 USD/h): {gesamtzeit / 3600 * 0.44:.3f} USD")
    return 0 if fehler == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
