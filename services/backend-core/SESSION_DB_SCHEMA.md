# Session-DB/Schema-Referenz (backend-core)

> **Wichtiger Hinweis:** Dieses Dokument beschreibt die **Referenz-/Offline-Sicht** des
> `backend-core`-Pakets. Es ist **nicht** die Quelle der Wahrheit für die produktive
> 4-User-Kollaboration von audioMONASTRY.

## Produktive Multi-User-Architektur (Quelle der Wahrheit)

- Session-Raum: `server.ts` verwaltet pro Session einen Socket.io-Room
  (`session:<id>`, Standard `session:main`) und repliziert Zustand an alle Mitglieder.
- Rollen/RBAC: `sessionRoles` werden serverseitig geführt; der erste User einer Session
  ist `admin`, weitere Rollen werden nur vom Server über `assign-role` vergeben.
- Plugin-/Modul-State: wird über `plugin-state` nur mit gültiger Rolle in den Session-Room
  gebroadcastet (`server.ts`).
- Client-State: lokale Browser-Speicher (localStorage, Scratchpad) sind **nur** für
  lokale UI-Präferenzen/Persistenz gedacht und **nicht** der Synchronisationskanal zwischen
  den bis zu vier Usern.
- WebRTC-Signaling/Locking: `src/utils/WebRTCManager.ts`, `src/context/PluginManagerContext.tsx`
  und die Socket.io-/Server-Pfade sind die aktiven Implementierungen; siehe `SIGNALING_PROTOCOL.md`
  für das Standalone-Referenzprotokoll des `backend-core/node`-Servers.

## Referenz-/Offline-Implementierung (backend-core standalone)

Die folgenden Einträge gelten nur, wenn der `backend-core`-Service separat ohne den
Hauptserver `server.ts` betrieben wird. In diesem Modus gibt es bewusst keinen
netzwerkübergreifenden 4-User-Zwang; für Produktiv-Sessions gilt die Architektur oben.

- Kollaborations-Session: `src/utils/collab.ts` (in-memory + localStorage-Nutzeridentitaet)
- B2B-Raeume: `src/hooks/useRoom.ts` / `src/components/B2BModal.tsx` (in-memory, pro Tab)
- Audit-Log: `src/utils/AuditLogger.ts` (Konsolen- + localStorage-Log)

## Objektstruktur (Referenz)

### Session (Standalone-Referenz)

> Warnung: Die hier gezeigte Browser-Map ist nur eine Offline-Referenz und keine
> Sicherheitsgrenze. Für Produktiv-Sessions sind Rollen und Locks serverseitig
> autoritativ zu führen (siehe Abschnitt „Produktive Multi-User-Architektur").

- `locks`: Map<String, userId> – plugin/module -> Besitzer
- `playback`: { isPlaying: Boolean, bpm: Number }
- `sequencer`: { patterns: Object, synthNotes: Array<Number> }
- `mastering`: { cutoff, resonance, delayTime, decay }
- `activeUsers`: Map<userId, { name, color, lastSeen }>
