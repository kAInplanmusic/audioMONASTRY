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

## Musik-Paket in Schritten von 100 (Bibliothek, nicht Archiv)

`scripts/media-ingest.py` archiviert ganze Bäume inhaltsadressiert. Für die
**Bibliothek** (`music/`) gilt eine andere Regel: der Schlüssel ist
`music/<sicher-name>.<endung>` (identisch zu `safeName` in
`server/routes/uploadRoutes.ts`) und die App findet die Datei über
`music_tracks.url = <CFR2_PUBLIC_URL>/music/<key>`.

```bash
# Trockenlauf: Auswahl, Volumen, erste Titel (nichts wird geladen)
python3 scripts/upload-music-batch.py --limit 100
# hochladen + Manifest data/r2-pakete/musik-paket-<stamp>.json
python3 scripts/upload-music-batch.py --limit 100 --yes
```

Auswahlregeln (deterministisch, idempotent):

* nur `.mp3`/`.flac` zwischen `--min-mb` und `--max-mb` (Standard 1–20 MB),
  also keine Riesen-Dateien;
* Genre aus dem ID3-`TCON` muss zu `--genre` passen (Standard: electro, techno,
  house, trance, minimal, …); ohne Tag entscheidet der Ordnername;
* DJ-Mixe/Megamixe sind per `--exclude` ausgeschlossen (keine Einzeltitel);
* bereits vorhandene Schlüssel (HEAD/List vor dem Lauf) werden übersprungen;
* führende Track-Nummern fallen aus dem Schlüssel (`01 - Orphx - Lost Again` →
  `music/orphx-lost-again.mp3`).

Voraussetzung: `CFS3_*` in der `.env` (nicht nur in `.env.deploy` — Skripte und
`npm run r2:check` lesen `.env`).

**Nach dem Upload fehlen die Datenbankzeilen** — Objekte allein erscheinen nicht
in der Bibliothek. `music_tracks` ist per RLS nur mit `service_role`
beschreibbar (`service_write_music`); offen als `MEDIA-2026-11-04-001`.

## Sample-Pakete: hochladen, messen, eintragen

Drei Schritte, jeder einzeln wiederholbar. Quelle ist der Ordnerbaum (Spiegel des
iCloud-Ordners `SAMPLES`), Ziel `samples/<pack>/<datei>.wav` plus eine Zeile in
`public.samples`.

```bash
python3 scripts/upload-samples-batch.py                 # Trockenlauf: Mengen
python3 scripts/upload-samples-batch.py --yes           # hochladen (idempotent)
python3 scripts/library-import-samples.py               # analysieren + anzeigen
python3 scripts/library-import-samples.py --yes         # Zeilen schreiben
```

`scripts/audio_meta.py` misst je Datei: Dauer, Samplerate, Kanäle, Codec,
Bittiefe, Dateigröße (ffprobe), Integrated Loudness + True Peak (ffmpeg
`loudnorm`) — und für Tonspuren ab 8 s zusätzlich Tempo (Autokorrelation der
Onset-Hüllkurve) und Tonart (Chroma + Krumhansl-Profil). **Beides nur mit
Konfidenz:** Tempo erst ab Verhältnis 2,5 zwischen Peak und Streuung, Tonart erst
ab r ≥ 0,45 und Vorsprung ≥ 0,06 — sonst bleibt das Feld leer. Ein falsches Tempo
in der Bibliothek ist schlimmer als ein leeres.

Abgeleitet (nicht gemessen): Typ aus dem Dateinamen (Kick, Snare, HiHat, Drum,
Break, Synth, Bass, FX, Track …), Kategorie aus dem Typ (bass/mids/highs),
Interpret aus dem Pack-Präfix (`Artist - Packname`), Stil aus Pack- und
Dateinamen (Hardcore, Gabber, Breakcore, Speedcore, Techno …), sonst
`Electronic`. Getaggt wird mit Pack, Stil, Typ, Kategorie, `kind`, `r2` und
`icloud-samples`.

Regeln, die beim Bauen wichtig waren:
* Typ zuerst aus dem **Dateinamen** — Packnamen wie „… Speedcore Bassdrums"
  machen sonst jede Datei zur Bass.
* Schlüssel sluggen (`samples/<pack>/<datei>`), Umlaute/akzente fallen weg;
  R2-Metadaten dürfen nur latin-1-fähige Zeichen tragen (ein kombinierender
  Akzent in `Les Champs Métalliques` brach sonst den PUT).
* Altzeilen mit unbearbeiteten URLs (Leerzeichen, Umlaute) sind Duplikate der
  neuen, geslugten Objekte und werden nach Größen-/Namensabgleich entfernt.

## Musikbibliothek anreichern

`music_tracks` hat keine Spalte für Lautheit — angereichert werden deshalb nur
`bpm`, `key` und (falls leer) `duration_seconds`. Quelle ist die lokale Datei,
sonst wird sie einmalig aus der öffentlichen URL in den Cache geladen.

```bash
python3 scripts/library-enrich-music.py        # Trockenlauf
python3 scripts/library-enrich-music.py --yes
```

Vorhandene Werte werden nie überschrieben.
