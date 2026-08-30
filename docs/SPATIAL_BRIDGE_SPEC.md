# Spatial-Bridge-Spezifikation (5.2.1)

Vollständige Spezifikation der digitalen/analogen Bridge zwischen App, Edge-DSP,
Cluster-Failover und 10-Kanal-Ausgangsstufe.

## Zielbild
- 10 unabhängige Spatial-Kanäle (2.0–18.2 über die App, 10-Kanal-Ausgangsstufe als Referenz)
- Bewegungsvektoren/Metadaten statt Raw-Audio zwischen App und Edge
- Edge-DSP mit Standby-Failover (klickfrei)
- Adaptive Netzwerkpfade: 5G / Wi-Fi 6E / Ethernet

## Komponenten & Rollen
| Komponente | Rolle |
|---|---|
| App (`SpatialPluginTerminal`, `spatialMath`) | Vektor-/Panning-/Routing-Status senden |
| Edge Gateway | Health-Monitoring, Routing, Failover-Steuerung |
| Cluster-Knoten (Master/Standby) | Spatial-DSP in Echtzeit, KI-Prädiktion |
| Multiplexer-Matrix (MAX4617 ×2 + CS8416) | Analog-Failover, S/PDIF-Bridge, Heartbeat-Switch |
| Ausgangsstufe | 10 Verstärker / 10 Lautsprecher |

## Protokoll (App → Gateway, JSON over WebSocket)
```json
{ "type": "vector", "sourceId": "s1", "x": 0.4, "y": -0.2, "bpm": 128, "key": "Am", "ts": 1730000000000 }
{ "type": "status", "gateway": "edge-1", "master": "node-a", "standby": ["node-b"], "latencyMs": 8, "failoverActive": false }
```
Referenz-Client: `src/core/edge/EdgeDspClient.ts`.

## Latenz-/Bandbreitenmodell
- 48 kHz, 64 Samples Block (~1,33 ms); Edge-DSP < 1 ms/Block; MUX < 100 ns
- Worst-Case: App → 5G (8 ms) → Gateway (0,5 ms) → Cluster (1 ms) → MUX → Verstärker → Lautsprecher ≈ **10,5 ms**

## Failover-Prinzip
1. Heartbeat des Masters fällt aus → 2. Gateway erkennt Ausfall → 3. MUX schaltet auf Standby → 4. genau ein aktiver Pfad (keine Phasen-Summen, kein Klick).
Referenz: `src/core/edge/FailoverController.ts` + `src/core/edge/EdgeRouter.ts`.

## Architekturregeln
- Keine Zusatzlatenz vor `masteringMONK`
- 4-User-Sync & Plugin-Locking unverändert
- Standby-Knoten werden nie parallel summiert
- Netzwerkpfade adaptiv, Audio-Pfade deterministisch
