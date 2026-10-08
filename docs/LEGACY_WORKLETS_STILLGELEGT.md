# Legacy-Worklets: stillgelegt (RT-AUDIT-P2-020)

Stand 2026-10-08. Kurznotiz, damit die Entscheidung nachvollziehbar bleibt.

## Befund

`audioEngine.init()` erzeugte acht AudioWorklet-Knoten, die **nie an den Ausgang
gehängt** wurden:

`dsp-processor`, `eq-processor`, `mastering-processor`, `effect-processor`,
`dynamics-processor`, `granular-processor`, `fm6-processor`,
`drumsynth-processor`.

Sie täuschten eine aktive native Kette vor, klangen aber nicht: der hörbare
Ausgang läuft ausschließlich über den **V2-Sink** (`v2-sink-processor` →
`V2SinkEngine` → `V2MonitorGraph`). Ebenso waren `analyzer-processor`
(currentFrame-Lückenlogik) und `lufs-processor` (Int32-SAB) nie verbunden.

## Entscheidung

Erzeugung **entfernt** (Default des Tickets). Konkret:

- `audioEngine.init()` legt die acht Knoten nicht mehr an; die Getter der
  `workletParamBridge` liefern `null` (Aufrufer nutzen `?.`).
- `setEqBand` und `setEqBands` senden nicht mehr an den alten `eqNode`; die App
  nutzt den **V2-Master-EQ** (Low/Mid/High) im AudioWorklet. Die 12-Band-Daten
  werden nicht mehr übertragen (die 12-Band-Kette war ein Feature des nie
  verbundenen Worklets – bei Bedarf eigenes Ticket).
- `src/core/audio/worklets/createWorkletNode.ts` (nur von `init()` benutzt) ist
  gelöscht.
- `analyzer-processor`/`lufs-processor` waren schon mit RT-AUDIT-P0-005 entfernt;
  Messwerte kommen aus dem V2-Mess-SAB (`V2Meters`).

## Was bleibt

Die Prozessor-**Dateien** der Legacy-Worklets bleiben im Repo und im
Worklet-Manifest (Build), werden aber von der Engine nicht mehr instanziiert.
Damit erzeugt die Engine keinen unverbundenen AudioNode mehr (Abnahme P2-020).

Eine spätere Wiederbelebung (z. B. echtes 12-Band-EQ-Worklet im V2-Pfad) wäre
eine eigene, additive Migration – der AudioGraph/V2-Sink kann Worklet-Knoten
bereits einbinden (`WorkletGraphRuntime`).
