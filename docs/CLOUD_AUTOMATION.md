# Cloud Automation – R2 ↔ Supabase

Stand: 2026-08-26

## Ablauf

```text
R2 (audiomonastrysamples)
        │  ListObjectsV2
        ▼
server/cloudAutomation.ts
  · analyzeAudioKey(key)  → Kategorie, Typ, Style, Tags, Artist/Title
  · ingestAudioObject()   → Supabase upsert (samples / music_tracks / sample_tags)
        │
        ▼
Supabase
  · samples        (WAV/FLAC/OGG/AIFF …)
  · music_tracks   (MP3/M4A/WEBM/OPUS …)
  · sample_tags    (normalisierte Tags)
```

## Endpunkte

| Endpoint | Funktion |
|---|---|
| `POST /api/cloud/sync` | Preset-Seed + vollständiger R2→Supabase-Abgleich |
| `POST /api/cloud/upload` | Upload nach R2 + automatische Analyse/Ablage in Supabase |
| `GET /api/cloud/health` | Konfigurationsstatus |

## CLI

```bash
npx tsx scripts/cloud_sync.ts
```

## Regeln

- Datei-Erweiterung bestimmt Sample vs. Music
- Kategorie: `bass` | `mids` | `highs`
- Typ: Kick/Drum/Hat/Vocal/FX/Synth/Loop/Stem/Track
- Style: techno/house/trance/goa/… aus Dateiname
- Tags: Kategorie + Typ + Style, gespiegelt in `sample_tags`
