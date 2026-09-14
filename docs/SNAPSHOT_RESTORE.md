# audioMONASTRY – Snapshot- & Restore-Anleitung (P1-2)

> Stand: 2026-09-13. Automatische, versionierte Snapshots des serverautoritativen
> Session-States (Revision, Modul-States, Locks, Sequenzen, Event-Historie).

## Was gespeichert wird

Jeder Snapshot enthält den vollständigen `SerializedAuthoritativeSession`-Zustand:

- Projekt-/Session-Metadaten (Session-ID, Revision, Server-Zeit)
- Nutzer- und Rollenstatus (Module, Sequenzen je Sender)
- aktive Locks (Lease/TTL)
- Event-Historie (Ringpuffer, max. 512 IDs)
- Checksumme (SHA-256 server-seitig) + Zeitstempel + Versionsnummer

## Automatik-Regeln

| Auslöser | Verhalten |
|---|---|
| Zustandsänderung (debounced 250 ms) | `persistSessionState()` → SnapshotStore.write + prune |
| Intervall (`SNAPSHOT_INTERVAL_MS`, Default 60 000) | periodischer Snapshot + prune |
| Retention | max. `SNAPSHOT_MAX_SNAPSHOTS` (Default 20) bzw. `SNAPSHOT_MAX_AGE_MS` (Default 7 Tage) |
| Cleanup | läuft nach jedem Schreiben; **der neueste gültige Snapshot wird nie gelöscht** |
| Dry-Run | `SnapshotStore.prune({ dryRun: true })` liefert Löschliste ohne Löschung |

## Restore

Der SnapshotStore validiert die Checksumme vor der Rückgabe. Server-seitig kann
der letzte gültige Stand über `sessionSnapshotStore.restore('latest')` gelesen
und an `AuthoritativeSession.restore()` übergeben werden.

## ENV

| Variable | Default | Bedeutung |
|---|---|---|
| `SNAPSHOT_INTERVAL_MS` | 60000 | Intervall automatischer Snapshots |
| `SNAPSHOT_MAX_SNAPSHOTS` | 20 | maximale Anzahl behaltener Snapshots |
| `SNAPSHOT_MAX_AGE_MS` | 604800000 (7 d) | maximale Aufbewahrungszeit |

## Tests

- `tests/snapshotStore.test.ts` (8 Tests): write/restore, Checksummen-Erkennung,
  Sortierung, maxSnapshots-Retention, maxAge-Retention, Dry-Run (nichts löschen),
  „neuester bleibt immer“, FNV-Fallback.
- Gesamt-Gate: `npm run verify` (tsc/eslint/vitest/boundary/audit).
