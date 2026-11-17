# audioMONASTRY — Phase C Audit 2 (Struktur): spatialMONK

**Plugin:** `spatial` / `spatialMONK`
**Stand:** Commit f5538c63
**Art:** Struktur-Audit — Architektur, Schnittstellen, Abhängigkeiten, Konsistenz zwischen den Schichten.

---

## 1. Grundkonzept

Spatial Audio für die 8 Kanalquellen: Pan, Breite, Positionierung als Channel-Insert pre-Summe (Vertrag), mit UI-Seitiger Szenen-Verwaltung (Presets, Quelle-Platzierung).

## 2. Architektur-Analyse

**Schicht 1 — Vertrag (`src/plugins/pluginContract.ts`):**
- `id: 'spatial'`, `role: 'insert'`, `channel: null`, `format: 'stereo'`, `inputs: 1`, `outputs: 1`
- `intrinsicLatencyFrames: 0`, `bypassable: true`, `sendsToFx: false`, `viaChannel: false`, `producesAudio: false`, `insertScope: 'channel'`
- `signalTopology().channelInserts = ['spatial']` (pre-Summe, im Kanalzug)

**Schicht 2 — UI (`src/components/`):**
- `SpatialScene.tsx` (memoisierte React-Komponente, Szene-State, LocalStorage-Persistenz via `readPluginSettings('spatial')`)
- `spatial/SpatialClubSetup.tsx`, `spatial/SpatialXYRoomController.tsx` (Raum-Controller)
- `src/types.ts`: `SpatialSceneState` (Version `spatialMONK-v1`, Quellen, Global)
- `src/presets.ts`: `DEFAULT_SPATIAL_SCENE`, `SPATIAL_SCENE_PRESETS`

**Schicht 3 — Adapter (`src/plugins/adapters/SpatialPluginAdapter.ts`):**
- Manifest: `kind: 'audio-router'`, `capabilities: ['spatial','audio-router']`, `latencySamples: 0`, `tailSamples: 0`
- `onProcess`: Pan (konstantes Leistungs-Pan) + Breite (Mid/Side-Skalierung), bit-gleiches Durchreichen bei Neutral
- `onParameter`/`onCommand`: `setup`, `mode` → `audioEngine.setSpatialSetup` / `setSpatialMode`

**Schicht 4 — Router (`src/core/pluginAudioRouter.ts`):**
- Zeile 69: `['spatial', 'ui-only', false]` → `isolation: 'ui-only'`, `mainFeeder: false`
- `chainStage`: aus `signalStageOf(id)` (signalChain.ts)

**Schicht 5 — Signalweg & Graph:**
- `src/plugins/signalChain.ts`: `processing = ['effect','eq','dsp','spatial','master']` (spatial in der Nachbearbeitungs-Stufe)
- `src/core/audio/C0StudioChain.ts`: `insertNodes.spatial = WorkletChainNode('chain:spatial','spatial')`, im Kanalstrip pre-Summe verkabelt; `WORKLET_BINDING.spatial = 'spatial-processor'`
- `src/core/audio/nodes/workletChainNode.ts` (Verweis): Worklet-Kette

**Schicht 6 — Engine-Integration:**
- `src/utils/audioEngine.ts`: `setSpatialSetup`, `setSpatialMode`, `spatialSceneV2` (Zeile 2481), `SpatialScene`-Instanz im Audio-Engine-Kontext

## 3. Technische Fehlannahmen (Strukturell)

1. **Annahme: Die Vertrags-Position `channelInserts` ist massgebend für alle Pfade.** `signalChain.ts` stuft spatial als `processing` (post-Summe) ein. Der Bounce (`pluginChainBounce.ts`) nutzt `SIGNAL_CHAIN_ORDER` aus `signalChain.ts` — im Bounce sitzt spatial daher nach dem Master, nicht pre-Summe wie im Vertrag. Strukturbrunch zwischen Offline- und Live-Pfad.
2. **Annahme: Ein Adapter reicht für das gesamte Feature.** Die UI unterhält eigenen Szene-State (`SpatialSceneState`), der Adapter kennt nur zwei Skalare (`pan`, `width`). Es gibt keinen serialisierten Abgleich zwischen Szene-Presets und Adapter-Parametern.
3. **Annahme: `ui-only` im Router ist konsistent mit einem Insert.** Der Router schließt spatial aus dem Audio-Graph aus, während Vertrag und C0-Graph es als Audio-Node einbauen. Jede Schicht hat eine andere Vorstellung davon, was spatial ist.

## 4. Designschwächen

- **Drei Stellen definieren die Einbauposition** (Vertrag, signalChain, C0StudioChain). Keine einzelne Quelle der Wahrheit.
- **UI-State und DSP-State sind entkoppelt.** Szene-Presets (LocalStorage) erreichen den Adapter nie; der Adapter arbeitet mit hartkodierten Defaults (`pan=0`, `width=1`), solange keine Parameter gesetzt werden.
- **Capability `'spatial'` ohne Umsetzung.** Das Manifest behauptet Spatial-Fähigkeit, der Adapter liefert Stereo-Pan. `ISpatialRenderer` aus `plugin_interface.ts` ist im Context definiert, wird aber nicht angerufen.
- **Mono-Eingang wird stillschweigend ignoriert** (Adapter Zeile 66–71: kein Pan bei `count === 1`).
- **Lazy-UI, starker Audio-Engine-Import.** `onParameter`/`onCommand` importieren `../../utils/audioEngine` dynamisch (`void import(...)`) — das koppelt den Adapter an die volle Engine, auch im Offline-Bounce/Kontext ohne Engine.

## 5. Performance-/DSP-Risiken

- Realtime-sicher: `onProcess` ist in-place, keine Allokation, frühzeitiger Return bei Neutral. Kein Risiko im Audio-Thread.
- Wird später HRTF/Convolution nachgerüstet: `tailSamples: 0` und `latencySamples: 0` wären falsch; Bounce würde Enden abschneiden, PDC würde nicht kompensieren.
- Die rAF-Analysator-Schleife in `SpatialScene` (UI) ist unabhängig vom Adapter, belastet aber den Hauptthread solange das Rack offen ist.

## 6. Schnittstellen-Probleme

| Schnittstelle | Zustand | Problem |
|---|---|---|
| `pluginContract.ts` ↔ `signalChain.ts` | `channelInserts: ['spatial']` vs. `processing` enthält `spatial` | Widerspruch pre/post Summe |
| `pluginContract.ts` ↔ `pluginAudioRouter.ts` | Insert, 1in/1out vs. `'ui-only'` | Audio-Graph vs. keine Route |
| `SpatialPluginAdapter` ↔ Manifest | `latencySamples: 0` | Passt zu Pan, nicht zu HRTF |
| `SpatialPluginAdapter` ↔ `SpatialScene` UI | `pan`/`width` vs. Szene-State | Kein Datenpfad zwischen UI-Szene und Adapter |
| `plugin_interface.ts` ↔ Adapter | `ISpatialRenderer` im Context | Nicht genutzt |
| `C0StudioChain` ↔ `pluginChainBounce` | C0: spatial pre-Summe; Bounce: `SIGNAL_CHAIN_ORDER` (post-Master) | Divergente Kette offline vs. online |

## 7. Empfohlene Korrekturen

1. **Ein einziger Ort für die Position.** Entweder `signalChain.ts` so ändern, dass spatial nicht in `processing` (sondern als Channel-Insert pre-Summe) behandelt wird, ODER Vertrag auf Master-Insert heben. `signalTopology()` und `SIGNAL_CHAIN` müssen deckungsgleich sein.
2. **Router an Vertrag angleichen.** `isolation` für spatial von `'ui-only'` auf `'insert'` (oder `'send'`) heben, damit `pluginAudioRouter` den Graphen nicht ausschließt. Alternativ Vertrag auf Nicht-Audio-Rolle ändern.
3. **UI-State an Adapter koppeln.** Szene-Positionen/Presets müssen serialisiert in Adapter-Parameter (`pan`, `width`, später HRTF-Parameter) überführt werden; `restore()`/`snapshot()` müssen die Szene abbilden.
4. **Mono-Path schließen.** Expliziten Mono→Stereo-Schritt oder Objekt-Renderer vor dem Pan einbauen.
5. **Manifest ehrlich machen.** Entweder Adapter auf echtes Spatial heben (Latenz/Tail deklarieren, `ISpatialRenderer` nutzen) oder Capability auf `'audio-router'` ohne `'spatial'` reduzieren und UI zurückbauen.
6. **Lazy-Engine-Import überprüfen.** Ob `audioEngine` im Offline-Bounce verfügbar ist; andernfalls Parameter über `setParameter` statt direkter Engine-Calls setzen.

**Fazit Struktur:** spatialMONK existiert in drei widersprüchlichen Ausprägungen (Vertrag, Router, signalChain/C0). Die Struktur ist nicht konsistent; vor jeder DSP-Erweiterung (HRTF) muss die Einbauposition verbindlich festgelegt werden.