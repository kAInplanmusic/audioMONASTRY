# Asset-DB-Schema (lokal, ohne Google/Firestore)

> Stand 2026-10-18. Früher war dies eine Firestore-Schema-Beschreibung;
> audioMONASTRY läuft ohne Firestore. Assets liegen als Dateien im Repo bzw. im
> Browser-Speicher. Deep-Audit-Bezug: DA-2026-09-29-048 (F65: keine lokal
> gebauten IDs im Runtime-Pfad).

## Speicherorte

| Was | Wo | Hinweis |
| --- | --- | --- |
| Samples, Loops, Referenztracks | `public/` (`music/`, `instruMONK/`, `spatialMONK/`, `wam/`) | wird vom Server statisch ausgeliefert (`express.static`) |
| Modelle | `public/models/` | eigener statischer Pfad mit MIME-/Range-Optionen (`server.ts`) |
| Worklets | `public/worklets/` bzw. `dist/worklets/` | siehe `build-worklets.mjs` |
| Benutzer-Presets | `localStorage` `audiomonastry_local_presets` (`src/utils/presetStore.ts`) | pro Browser, bewusst nicht server-synchronisiert (`src/utils/storage.ts`) |
| Projekt-/Scratchpad-Altdaten | `indexedDB` `AudioMonastryDB` (`src/utils/indexedDB.ts`) | nur Altbestand-Import |

## Objektstruktur (unverändert, nur Speicherort abweichend)

### 1. Sample / Asset
- `id`: String – bei Celery-Aufgaben die Task-ID des Servers (`task.id`);
  im Frontend aus dem Dateipfad abgeleitet. Einen lokalen ID-Generator mit
  eigenem Format gibt es nicht (bewusst, siehe F65).
- `type`: String (`sample`, `stem`, `recording`)
- `path`: String (relativer Pfad unter `public/` oder Dateisystem-Pfad)
- `name`: String
- `metadata`: Map
  - `duration`: Number (Sekunden)
  - `sampleRate`: Number (Hz)
  - `bpm`: Number
  - `tags`: Array<String>

### 2. Preset
- `id`: String (aus Name + Zeitstempel im Browser gebildet)
- `name`: String
- `data`: Map (JSON-Repräsentation des Presets)
- `createdAt`: String (ISO)

## Abgrenzung

Dieses Schema beschreibt Datei-/Browser-Ablage, NICHT die kollaborative
Session. Die Autorität für Session-, Plugin- und Lock-Zustand steht in
`SESSION_DB_SCHEMA.md` (dort: der Server).
