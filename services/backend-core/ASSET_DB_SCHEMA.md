# DB1: Asset DB Schema (Lokal – Google-frei)

> Frueher war dies eine Firestore-Schema-Beschreibung. audioMONASTRY laeuft jetzt
> OHNE Google/Firestore komplett lokal. Assets werden auf dem Hetzner-Dateisystem
> bzw. im Browser (localStorage/IndexedDB) gespeichert.

## Lokale Speicherorte

- `public/samples/` – lokale WAV-Sample-Dateien (werden vom Server direkt ausgeliefert)
- `localStorage` (Browser) – Benutzer-Presets (`audiomonastry_local_presets`)
- `indexedDB` (Browser) – Scratchpad-/Projekt-Daten

## Objektstruktur (unveraendert, nur Speicherort abweichend)

### 1. Sample / Asset
- `id`: String (lokal generiert)
- `type`: String ("sample", "stem", "recording")
- `path`: String (relativer oder Dateisystem-Pfad)
- `name`: String
- `metadata`: Map
  - `duration`: Number
  - `sampleRate`: Number
  - `bpm`: Number
  - `tags`: Array<String>

### 2. Preset
- `id`: String (lokal generiert)
- `name`: String
- `data`: Map (JSON-Repraesentation des Presets)
- `createdAt`: String (ISO)
