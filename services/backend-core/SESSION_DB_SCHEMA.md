# Session-/Lock-Autorität (Stand 2026-10-18)

> **Eine Quelle der Wahrheit.** Dieses Dokument beschreibt, WER den Session-,
> Plugin- und Lock-Zustand führt. Es ersetzt die frühere Fassung, die eine
> in-memory-/localStorage-Session UND eine Server-Session nebeneinander
> beschrieben hat (Deep-Audit DA-2026-09-29-049, Befund F84).

## 1. Autoritativ: der Server

| Zustand | Ort | Regel |
| --- | --- | --- |
| Session-State, Revisionen, Sequenzen | `src/core/session/authoritativeSession.ts`, eingebunden in `server/realtime.ts` | Jede akzeptierte Mutation erhöht die Revision (monoton). Events mit bekannter `eventId` (`duplicate`) oder `sequence <= letzter Sequenz des Senders` (`stale-sequence`) werden verworfen. |
| Basisrevision (optimistische Nebenläufigkeit) | `authoritativeSession.ts` (`baseRevisionFor`, `applyEvent`), Client-Gegenstück `src/core/session/pluginRevisionTracker.ts` | Passt `baseRevision` nicht zum Stand DIESES Plugins, wird das Event ohne Mutation abgelehnt (`stale-base-revision`) und der kanonische Stand zurückgegeben. Ohne `baseRevision` bleibt das Altverhalten. |
| Locks | `src/core/session/locking.ts` (`LockManager`), benutzt von `authoritativeSession.ts` | Prüfen+Setzen ist eine synchrone, nicht unterbrechbare Operation; Lease mit TTL und Heartbeat, Freigabe durch den Halter. Fremde aktive Locks blockieren `plugin-state`. |
| Rollen | `server/realtime.ts` (`sessionRoles`, `assign-role`) | Nur der Server vergibt Rollen; der erste Nutzer einer Session ist `admin`. |
| Snapshot / Reconnect | `authoritativeSession.snapshot()` / `serialize()` / `restore()` | Der Snapshot ist die Resync-Basis nach Join/Reconnect. |

## 2. Client: Transport und Cache, keine Autorität

- `src/utils/WebRTCManager.ts` transportiert `plugin-state` (DataChannel und
  Socket.io) und schickt die Basisrevision mit; `pluginRevisionTracker.ts`
  merkt sich je Plugin die **bestätigte** Revision (plus eigene, noch
  unbestätigte Schreibvorgänge) und entscheidet bei Ablehnung zwischen genau
  einer Wiederholung und Aufgabe.
- `localStorage` hält ausschliesslich lokale UI-Präferenzen, nie den
  Session-Zustand: `audiomonastry_user_id` (lokale Identität),
  `audiomonastry_local_presets` (Presets pro Browser, bewusst NICHT über den
  Studio-Speicher synchronisiert, siehe `src/utils/storage.ts`).
- `indexedDB` dient nur noch dem Import von Altbeständen
  (`AudioMonastryDB`, `src/utils/indexedDB.ts`).

## 3. Historische Referenz (nicht produktiv, nicht deployt)

- `services/backend-core/node/index.js` ist ein Standalone-Signaling-Prototyp
  auf rohem `ws` mit eigener in-memory Session (Protokoll:
  `services/backend-core/SIGNALING_PROTOCOL.md`). Kein Compose-Service, kein
  Startpfad, keine Autorität für die App.
- `services/backend-core/python/device_utils.py` wird als EINZIGES Modul aus
  diesem Verzeichnis produktiv eingeblendet (Geräte-Wahl für celery_app und
  stem-ai, siehe `docker-compose.yml`).
- Die früher hier genannten Browser-Pfade `src/hooks/useRoom.ts` und
  `src/components/B2BModal.tsx` existieren nicht mehr. `src/utils/collab.ts`
  ist eine lokale Attrappe (früher Firestore) ohne Server-Sync; sie führt
  KEINEN zweiten Session-State, den ein Client für verbindlich halten dürfte.
