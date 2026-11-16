# R18 Latenzkompensation für 5ms Lookahead-Limiter

## Problemstellung

Ein 5ms Lookahead-Limiter im Backend-Master verzögert das Signal um exakt 5ms (240 Samples bei 48kHz), um Spitzen abzufangen. Wenn der Limiter im Backend-Master das Signal verzögert, zieht er die gesamte PA-Ausgabe 5ms nach hinten.

## Lösung: Synchrones Delay in Monitor-Pfad

**Kein zusätzlicher Delay erforderlich!**

Beide Audiopfade (PA und Monitor/Cue) erhalten über den WebSocket dieselbe verzögerte Audiospur vom Backend-Master. Das bedeutet:

- **PA-Pfad**: Backend-Master WebSocket → MasterOutPage → PA-Interface
- **Monitor-Pfad**: Backend-Master WebSocket → V2MonitorGraph → DJ-Cue

Da beide Pfade dieselbe verzögerte Audiospur erhalten, ist der DJ-Cue synchron zur PA-Ausgabe - kein Echo-Effekt entsteht beim Auflegen.

## Technische Details

### Backend-Master (limitiert)
- `server/backendMainWorker.ts`: Verarbeitet Audio mit MasteringDynamics Limiter
- `server/backendMainProcessors.ts:255`: Limiter ist AFTER master gain, BEFORE PCM24 rounding
- Lookahead: 5ms (240 Samples @ 48kHz)

### Transport (WebSocket)
- `src/pages/MasterOutPage.tsx`: PA-Audio kommt vom Backend-Master via WebSocket
- `src/core/transport/backendMainClient.ts`: Liefert delayed audio an Browser

### Monitor-Pfad
- `src/hooks/useBackendMainMonitor.ts`: Empfängt denselben WebSocket-Stream
- `src/core/audio/V2MonitorGraph.ts:66, 106-110, 204, 304-306`: Bestehende PDC-Kompensation für lokale V2-Grafik-Pfade

### Warum keine zusätzliche Kompensation nötig ist:
1. Der DJ-Leiste (Cue) im lokalen V2 hat bereits PDC-Kompensation für den lokalen MasteringNode
2. Der Backend-Master-Pfad für PA und Monitor nutzt denselben WebSocket-Stream
3. Beide Pfade sind synchron, weil sie dieselbe verzögerte Source verwenden

## Verantwortlichkeiten

- **Backend**: Limiter verzögert Audio um 5ms (unvermeidlich für Lookahead)
- **Frontend**: Empfängt verzögerte Audio → beide Ausgänge synchron
- **DJ-Erlebnis**: Synchron, kein Echo

## Referenzen

- V2MonitorGraph.ts: PDC-Implementierung für lokale Audiopfade
- backendMainWorker.ts: Hauptverarbeitungsweg für PA-Audio
- MasterOutPage.tsx: PA-Ausgabe über WebSocket
- useBackendMainMonitor.ts: Monitor-Audio via WebSocket