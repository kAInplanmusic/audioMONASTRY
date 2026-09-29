# visual-vorrat — Bilder im Voraus erzeugen

Werkzeuge des Bild-Vorratslaufs: der Lauf erzeugt 2080 Bilder (16 LoRA-
Kombinationen × 10 Motive × 13 Seeds) über den Serverless-Endpoint, damit der
Visualizer später aus einem Vorrat wählen kann statt bei jedem Klick einen
Kaltstart zu bezahlen.

**Gemessen:** 13 min Kaltstart gegen ~20 s pro Bild im warmen Worker. Deshalb
läuft der Lauf als **eine** lange Sitzung, nicht als viele Einzelaufrufe.

## Die zwei Einstiegspunkte

| Datei | Zweck |
|---|---|
| `batch-bilder.py` | Der Lauf selbst. `python3 batch-bilder.py --gruppe --limit 0 --out bilder-vorrat` |
| `vorrat-wache.sh` | Startet den Lauf neu, wenn er stirbt (alle 60 s eine Prüfung) |

```bash
cd ~/lora-themen-2026-09-27
python3 batch-bilder.py --limit 16 --out bilder-pilot   # Trockenlauf
python3 batch-bilder.py --gruppe --limit 0 --out bilder-vorrat
ls bilder-vorrat/*.png | wc -l      # Fortschritt
tail -f vorrat.log                  # je Bild eine Zeile
tail -f vorrat-wache.log            # was die Wache tut
```

`--gruppe` ordnet nach Kombination: aufeinanderfolgende Bilder nutzen dieselben
LoRAs, ComfyUI lädt sie einmal statt bei jedem Bild. Ohne `--gruppe` deckt ein
kleines `--limit` zuerst alle Kombinationen ab (für den Pilotlauf).

## Wo die Daten liegen — und warum nicht hier

Der Code läuft im Arbeitsordner `~/lora-themen-2026-09-27`, **nicht** in diesem
Verzeichnis. 3,2 GB erzeugte Daten (Bilder 1,6 GB, Bundles, `out*/`,
`ergebnisse/`, Protokolle, `datei-index.json`) sind bewusst nicht im Repo;
`.gitignore` in diesem Ordner hält die Muster fest.

## Wiederaufsetzbar — und was daran kaputt war

Ein Neustart darf nichts doppelt bezahlen. Das war **nicht** gegeben:

`hash((kombo, motiv, seed))` salzt Python je Prozess. Derselbe Auftrag ergab in
zwei Prozessen `psy_techno__25563211` und `psy_techno__72407584` — ein Neustart
hätte die vorhandenen Bilder nicht wiedererkannt und **alle 2080 erneut erzeugt
und bezahlt** (rund 11 h, ~5 USD).

Behoben, zwei Vorkehrungen, beide nötig:
1. Kennung aus einem stabilen Streuwert (sha1) statt `hash()`.
2. Übersprungen wird zusätzlich über `manifest.jsonl`, nach der **Bestellung**
   `(kombo, motiv, seed)` statt nach dem Dateinamen — damit werden auch Bilder
   aus der Zeit vor der stabilen Kennung erkannt.

**Beleg:** Trockenlauf gegen eine Manifest-Kopie, Bildabruf scharf gestellt
(ruft er, bricht er ab) → `0 neu, 29 uebersprungen, 0 Fehler`. Namenskollisionen
über alle 2080 Aufträge: 0.

## Die Wache

Sie sieht alle 60 s nach; fehlt der Lauf und ist noch nicht alles da, startet
sie denselben Aufruf neu. Zwei Fehler in ihr wurden beim Prüfen gefunden und
behoben — beide hätten sie wirkungslos gemacht:

* Das Suchmuster `batch-bilder.py` fand **jeden** Prozess mit diesem Text in der
  Kommandozeile, auch die abgesetzte Start-Hülle. Die Wache hätte den Lauf für
  lebendig gehalten, obwohl er tot ist. Jetzt: `^python3 -u batch-bilder.py`.
* Der Sperr-Deskriptor wurde an Kindprozesse vererbt; ein verwaistes `sleep 60`
  hielt die Sperre und **keine neue Wache kam mehr hoch**. Kinder schließen den
  Deskriptor jetzt (`9>&-`).

Bremse: Bringt ein Neustart nichts, bricht sie nach `OHNE_FORTSCHRITT_MAX`
Minuten (Vorgabe 45) ohne neues Bild ab, statt endlos weiterzustarten.

## Nicht im Repo: zwei Dateigruppen mit Zugangsdaten

Beim Übernehmen des Arbeitsordners am 28.09.2026 gefunden:

* `pod-lora-*.json` — rohe RunPod-Antworten, enthalten `RUNPOD_API_KEY=rpa_…`
  und `HF_TOKEN=hf_…` **im Klartext**, dazu SSH-Public-Key und Container-Env.
* `build-urls.json` — presignierte R2-URLs mit `X-Amz-Credential` und Signatur,
  48 h gültig ab 27.09.2026.

Beide wurden **nicht** übernommen; die Muster stehen in `.gitignore`. Prüfung
nach dem Kopieren: `grep -rIlE "(rpa_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|X-Amz-Signature)" .`
→ Treffer nur in `r2.py`, und dort nur das SigV4-**Format**
(`"{access_key}/{credential_scope}"`), kein Wert.

## Hinweise zum Betrieb

* Die Skripte enthalten **absolute Pfade** (`comfyui_adapter.py` aus diesem
  Repo, `.env` der App, `/home/patrick/…`) — sie laufen auf diesem Rechner,
  nicht in einem Container.
* `batch-bilder.py` schickt den Handler-Input unter `"input"`; ohne diese Hülle
  antwortet der Worker mit *„Job has missing field(s): id or input"* — der Job
  kommt nie an, der Kaltstart ist trotzdem bezahlt.
* Kosten laufen über den gemessenen Satz von 0,44 USD/h; der Lauf rechnet sie am
  Ende selbst aus.
