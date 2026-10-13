# MEDIA_INGEST.md

Medien-Archiv: BRAIN-Platte (Bilder, Musik, Videos) in den Speicher laden

## Zweck
Auf dem Rechner, an dem die WD-Platte hängt, Medien inhaltsadressiert in R2/B2 laden.
Dedupe per SHA-256, fortsetzbar, Index-JSONL.

## Vorausetzung
* scripts/media-ingest.py vorhanden
* scripts/s3lite.py vorhanden
* Umgebungsvariablen für R2 (siehe .env.deploy):
  CFS3_ACCESS_KEY, CFS3_SECRET_KEY, CFS3_BUCKET, CFS3_ENDPOINT
  oder CFR2_ACCOUNT_ID

## Nutzung
Trockenlauf, Mengen + Kosten:
```bash
cd /mnt/wd-elements/Medien/Projekte/audioMONASTRY
python3 scripts/media-ingest.py /mnt/wd-elements/Bilder \
  --target r2 --min-kb 1024
```
Hochladen:
```bash
python3 scripts/media-ingest.py /mnt/wd-elements/Bilder \
  --target r2 --yes --min-kb 1024 --tag brain
```

## Akzeptanz MEDIA-P1-001
* Lauf ohne --yes zeigt Mengen und Kosten
* Lauf mit --yes lädt alles hoch, Doppelte nur einmal
* Index media/index/*.jsonl vorhanden

## Kosten
Gemessen 2026-10-13:
* Bilder: 26 802 Dateien, ~152.4 GB → ~2.29 $/Monat R2
* Musik: 15 878 Dateien, ~145.5 GB → ~2.18 $/Monat R2
* Videos: 1 199 Dateien, ~177.9 GB → ~2.67 $/Monat R2
* Medien-Ordner gesamt: 18 942 Dateien, ~289.1 GB → ~4.34 $/Monat R2

Budget-Konstitution erlaubt 5 EUR/Monat → Entscheidung nötig.
B2 wäre günstiger ~0.007 $/GB/Monat.

## Hinweis
Betreiber-Entscheidung für Ziel und Budget erforderlich. Nach Upload Folgeschritt: serverseitige Umwandlung via ffmpeg / media-Knoten für Formate, die der Browser nicht abspielt.
