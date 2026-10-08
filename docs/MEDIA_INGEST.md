# Medien in den Speicher laden (BRAIN-Platte & Co.)

Werkzeug: `scripts/media-ingest.py` (nur Python 3.9+, keine weiteren Pakete). Es läuft auf
dem Rechner, an dem die Platte hängt; die Cloud-Umgebung der Entwicklung kommt an lokale
Platten nicht heran.

## Was aufgenommen wird (Betreiber 2026-10-07: „alles, auch verlustfrei und HQ")

| Art | Endungen |
|---|---|
| Ton verlustfrei/HQ | wav, wave, bwf, rf64, w64, aif, aiff, aifc, flac, wv (WavPack), ape, tta, tak, dsf/dff (DSD), caf, mka, m4a/alac |
| Ton verlustbehaftet | mp3, mp2, aac, m4b, ogg, oga, opus, weba, wma, ac3, eac3, dts |
| Bilder | jpg, png, webp, avif, heic/heif, tif/tiff, gif, bmp, jxl, psd, Kamera-RAW (dng, cr2, cr3, nef, arw, orf, rw2, raf, srw, pef) |
| Videos (für Visuals) | mp4, m4v, mov, mkv, webm, avi, wmv, mpg/mpeg, mts/m2ts/ts, 3gp, flv, mxf, ogv |
| Sonst | MIDI (mid, midi) für den Sequenzer, Farb-LUTs (cube, 3dl) für Visual-Looks |

Übersprungen: Papierkorb-/Systemordner, `._*`, `Thumbs.db`, Dateien unter 1 KB, alle
anderen Endungen (werden gezählt und angezeigt).

Gespeichert wird immer das **Original, unverändert** (inhaltsadressiert, Doppelte nur
einmal). Die App selbst spielt im Browser nur wav/mp3/flac/ogg/oga/opus/weba/m4a/aac/aiff;
für DSD, APE, WavPack, RAW usw. kommt eine serverseitige Umwandlung (ffmpeg auf dem
media-Knoten) als nächster Schritt.

## Ablauf

```bash
# 1. Zählen und Kosten sehen (nichts wird hochgeladen)
python3 scripts/media-ingest.py /media/<user>/BRAIN

# 2. Hochladen – Standardziel Backblaze B2 (günstigstes Archiv)
B2_BUCKET=audioMONASTRY B2_KEY_ID=… B2_APP_KEY=… \
python3 scripts/media-ingest.py /media/<user>/BRAIN --yes

# Nur Musik, mit Tags
python3 scripts/media-ingest.py /media/<user>/BRAIN/Musik --yes --kinds audio,midi --tag techno --tag elektro
# Nach R2 statt B2 (dort liest die App heute)
python3 scripts/media-ingest.py /media/<user>/BRAIN/Visuals --yes --target r2 --kinds image,video,lut
```
Abbruch mit Strg+C jederzeit; ein neuer Lauf macht weiter (bereits hochgeladene Objekte
werden erkannt, Hashes liegen in `~/.cache/audiomonastry-ingest/`).

## Kosten (2 TB als Richtwert)

| Ziel | Speicher | Abruf |
|---|---|---|
| B2 | ~0,007 $/GB/Monat → 2 TB ≈ **14 $ (≈ 13 €)/Monat** | 3× Speichermenge/Monat frei, danach 0,01 $/GB |
| R2 | ~0,015 $/GB/Monat → 2 TB ≈ **30 $ (≈ 28 €)/Monat** | frei |

Achtung: Die Konstitution erlaubt bisher **5 €/Monat** für Speicher. Eine volle 2-TB-Platte
sprengt das in jedem Fall; vor dem vollen Lauf Budget anheben oder auswählen (`--kinds`,
Unterordner).

## Ablage

```
media/<art>/<sha256[:2]>/<sha256>.<endung>    Original
media/index/<zeit>-<rechner>.jsonl            je Datei: sha256, Art, Pfad, Größe, Tags, Status
```
Der Index ist die Grundlage für die Visual-Bibliothek (Tagging/CLIP) und die Sample-Bibliothek.
