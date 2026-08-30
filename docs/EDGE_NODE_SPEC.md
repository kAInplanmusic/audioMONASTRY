# Edge-Node-Spezifikation (7.2.1)

## Anforderungen
- Linux-Echtzeit-Kernel (PREEMPT_RT), `cpufreq` auf Performance
- Audio-Clock-Sync via PTP/NTP + PLL (Referenz: `src/utils/ClockSync.ts`, `PhaseLockedLoop.ts`)
- DSP-Worker pro NUMA-Node, Buffer 64 Samples @ 48 kHz
- Heartbeat alle 250 ms an das Gateway

## Rollen
| Knoten | Aufgabe |
|---|---|
| Master | aktive Spatial-DSP, Clock-Quelle |
| Standby | warm berechnet, kein Audio-Ausgang |

## Anbindung an die App
- App sendet Vektoren/Metadaten (`src/core/edge/EdgeDspClient.ts`)
- Routing/Anycast über `src/core/edge/EdgeRouter.ts`
- Failover über `src/core/edge/FailoverController.ts` (Stereo-Fallback)

## Health-Check
`GET /health` muss innerhalb 2 s antworten:
```json
{ "status": "ok", "latencyMs": 0.4, "active": true, "channels": 10 }
```
