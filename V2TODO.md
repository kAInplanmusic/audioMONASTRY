# V2TODO – V2 wird der einzige Audio-Pfad

> Branch: `v2-complete`
> Ziel: **V2-AudioGraph ersetzt V1 vollständig** – V1 wird nach erfolgreicher Parität entfernt.
> Stand: 2026-09-09 · Phase 1–8 komplett grün (inkl. E2E-Live-Gate headed, 21:20); V1-Entfernung (Phase 9) offen

---

## 1. Entscheidung

- **V2 wird der einzige Produktiv-Audiopfad.**
- V1 (Tone.js/`audioEngine`-Monolith) wird **nicht mehr gepflegt** und nach Parität entfernt.
- Kein dauerhafter Dual-Mode; Hybrid nur als temporäre Migrationsbrücke während der Entwicklung.

## 2. Ist-Zustand V2

| Baustein | Datei | Status |
|---|---|---|
| V2 Studio Graph (10 Kanäle) | `src/core/audio/V2StudioGraph.ts` | ✅ Grundstruktur |
| AudioGraph + Node-Modell | `src/core/audio/AudioGraph.ts`, `nodes/basicNodes.ts` | ✅ |
| WorkletGraphRuntime | `src/core/audio/WorkletGraphRuntime.ts` | ✅ |
| GraphStateBridge | `src/core/audio/GraphStateBridge.ts` | ✅ 10 Kanäle |
| V2MonitorGraph (Cue/Main/Monitor) | `src/core/audio/V2MonitorGraph.ts` | ✅ Phase 4 |
| V2OutputGraph (2.1/Spatial) | `src/core/audio/V2OutputGraph.ts` | ✅ Phase 4 |
| GraphEngineAdapter | `src/core/audio/compat/GraphEngineAdapter.ts` | ✅ V1↔V2 Sync |
| GraphPlaybackEngine | `src/core/audio/compat/GraphPlaybackEngine.ts` | ✅ Offline-/Test-Renderer; KEIN setInterval (Live-Transport läuft über `v2SinkProcessor`/`V2SampleClock`) |
| V2-Modi in Engine | `src/utils/audioEngine.ts` | ✅ Feature-Flag-Default (`VITE_V2_AUDIO_MODE`) |
| V2 Feature-Flags | `src/utils/v2FeatureFlags.ts` | ✅ Phase 7a |
| V2 Terminal Bridge | `src/core/audio/compat/V2TerminalBridge.ts` | ✅ Phase 7a |
| OfflineBounceEngine | `src/audio/bounce/OfflineBounceEngine.ts` | ✅ WorkletChain + V2-Node-Chain |
| V2 Processing Nodes (EQ/DSP/FX/Dyn/Master) | `src/core/audio/nodes/processingNodes.ts` | ✅ Phase 5 |
| V2 Node Automation (Coalescer) | `src/core/audio/state/v2NodeAutomation.ts` | ✅ Phase 5 |
| V2 Session State (Export/Import/Merge) | `src/core/session/v2SessionState.ts` | ✅ Phase 6 |
| V2 Lock/RBAC-Sync | `src/core/session/v2LockSync.ts` | ✅ Phase 6 |
| V2 SFU/WebRTC-GraphState-Kopplung | `src/core/session/v2SfuSync.ts` | ✅ Phase 6 |

**Kern-Lücken:**
1. UI/Server-Sync der Kollaboration läuft noch über V1; V2-Session-/Lock-/SFU-State-Module sind vorhanden
2. UI spielt weiterhin V1
3. Kein vollständiger Test-Paritätsnachweis V1 ↔ V2

## 3. Zielarchitektur

```text
UI / Plugins
   │
   ▼
V2 Audio-Engine (einziger Pfad)
   │
   ├── Sources: Player/Sampler/Synth → V2 SourceNodes
   ├── Graph: Gain/Pan/EQ/DSP/Effect/Mastering/Spatial als V2-Nodes
   ├── Scheduler: sample-genau (AudioWorklet-Clock / V2-Tick)
   ├── Output: hörbar via AudioWorklet-Adapter / Backend
   ├── Offline: identische Graph-Struktur für Bounce/Export
   ├── Control: MIDI/HID/OSC → V2-Parameter
   └── Kollaboration: State-Sync über V2-GraphState
```

V1-Elemente werden durch V2-Äquivalente ersetzt:
- Tone.js-Player → V2 SampleSource / WebAudio-Bridge
- Tone.Transport → V2 Clock/Scheduler
- Tone.Volume/Filter → V2 GainNode/FilterNode
- AudioWorklet-Direktverdrahtung → WorkletGraphRuntime-Nodes

## 4. Migrationsphasen

### Phase 0 – Branch & Plan (diese Datei)
- [x] Branch `v2-complete` erstellt
- [x] `V2TODO.md` angelegt
- [ ] VISIONS-/TODO-Abgleich dokumentieren (unten)

### Phase 1 – V2 hörbar machen (Proof of Audio)
- [x] V2-Live-Output-Sink (rendered Float32-Blöcke → AudioContext-Destination)
- [x] Test: einfacher V2-Testton hörbar/automatisiert nachweisbar
- [x] `V2StudioGraph.render()` an echten Audio-Output anbinden

### Phase 2 – Sample-genauer Scheduler
- [x] `GraphPlaybackEngine` von `setInterval` auf AudioWorklet-/Lookahead-Scheduler umstellen
- [x] Jitter-/Latenz-Test (8–15 ms lokal)
- [x] PDC (Lookahead-Mastering) in V2 abbilden

### Phase 3 – Quellen nach V2
- [x] Sample-Player als V2-Source
- [x] Tone.js-/Browser-Player über V2-Bridge speisen
- [x] Sampler/Synth-Worklets als V2-Nodes registrieren
- [x] SFZ-/Instrument-Pfade auf V2 umstellen

### Phase 4 – Kanal-/Routing-Parität
- [x] GraphStateBridge auf 10 Kanäle erweitern (aktuell 8)
- [x] `pluginChannelMap`/Monitor-Routing in V2 abbilden
- [x] Cue/Main/Monitor-Pfade als V2-Graph
- [x] Spatial-Bus/2.1-Mehrkanal in V2

### Phase 5 – DSP/Effekt/Mastering
- [x] EQ/DSP/Effect/Dynamics/Mastering als V2-Nodes
- [x] Parameter-Automation (Coalescer) an V2-Nodes anbinden
- [x] WorkletChain in `WorkletGraphRuntime` produktiv nutzen
- [x] Offline-Bounce über denselben V2-Graph

### Phase 6 – Kollaboration/Session
- [x] Session-State aus V2 exportieren/importieren
- [x] Locking/RBAC mit V2-State synchronisieren
- [x] WebRTC/SFU-State mit V2-GraphState koppeln

### Phase 7 – UI-Umstellung
#### Phase 7a – V2-Default + Feature-Flag + Terminal-Bridge (umgesetzt)
- [x] `setPlaybackMode`-Default über `VITE_V2_AUDIO_MODE` steuerbar; V1-Pfad hinter `VITE_V2_AUDIO_ONLY`-Flag
- [x] Zentrale `V2TerminalBridge` (`audioV2TerminalBridge`) als stabile Terminal-/Plugin-API vorbereitet
- [x] `.env.example` dokumentiert den Produktiv-Umstieg auf `v2`

#### Phase 7b – Terminal-Bridge-Drop-in (umgesetzt)
- [x] `audioEngine`-Export läuft als transparente V2-Terminal-Bridge (Proxy mit Auto-`syncV2FromV1`); alle bestehenden Plugin-Terminals nutzen damit ohne Einzel-Rewrites die V2-Bridge
- [x] `audioV2TerminalBridge` als expliziter Drop-in-Alias exportiert
- [x] `terminalShared` (Play/Stop) explizit auf `audioV2TerminalBridge` umgestellt
- [x] V2-Default produktiv scharfschalten vorbereitet: `VITE_V2_AUDIO_MODE=v2` in `.env.example` dokumentiert
- [ ] V1-Pfad hinter Feature-Flag vollständig ausblenden und entfernen (Phase 9)

### Phase 8 – Paritäts-/Hörtests
- [x] V1↔V2 Paritätstest (VISIONS B8) – automatisiert in `tests/v2Parity.test.ts`
- [x] A/B-Hörtest-Proxy (deterministisch, Pegel-/Hashing-Vergleich) in `tests/v2Parity.test.ts`
- [x] `npm run verify` komplett grün (931 Tests, Stand AP1–AP3)
- [x] `npm run build` grün
- [x] E2E-Live-Gate (Playwright headed gegen echten V2-AudioWorklet-Pfad; inkl. Tone-15-`rawContext`-Unwrap-Fix in `audioEngine.init()`)

### Reale Audio-Verifikation (AP1–AP3)
- [x] AP1: Live-V2-E2E-Gate angelegt (`tests/e2e/v2-live.spec.ts`, `skip` in Headless; benötigt audio-fähigen Browser/Live-Instanz)
- [x] AP2: Sample-genauer Scheduler läuft im echten AudioWorklet (`V2SampleClock` + `v2SinkProcessor`); frame-exakte Tests grün
- [x] AP3: Echte V1-Worklet-Klassen (`EqProcessor`, `DspProcessor`, `EffectProcessor`) exportiert; `tests/v2DspV1Parity.test.ts` vergleicht echte V1-Klassen mit V2-Nodes

### Phase 9 – V1 entfernen
- [x] Tone.js-/V1-Abhängigkeiten entfernen, soweit möglich (2026-09-10: `tone`-Paket bereits entfernt; **V1-Transport-Zweige, No-Op-Synth-Felder, Fake-Mastering-Kette und Legacy-Worklet-Doppelpfad aus `audioEngine.init()` entfernt**; Live-Gate headed grün)
- [~] `audioEngine.ts`-Monolith durch V2-Module ersetzen (2026-09-10: Facade ist jetzt reine V2-Terminal-Bridge mit Zustandsfeldern; vollständiger Datei-Split bleibt P1 → `MASTER_TODO.md` AUDIO-P1-002)
- [x] Doku/README auf V2-only umstellen (README/README_DE deklarieren V2 als einzigen Produktiv-Pfad; `MASTER_TODO.md` ist kanonische Ausführungsliste)

## 5. Gleichzeitig mitnehmen (Visions + bestehende TODOs)

> Bei einem so großen Umbau sollten diese Punkte direkt in V2-Architektur gebaut werden:

| Quelle | Punkt | In V2 integrieren als |
|---|---|---|
| VISIONS B1 | V2-AudioGraph live als dynamischer Patch-Bay-Router | V2 Node-Graph (variabel, Feedback erst nach Tests) |
| VISIONS B8 | V1/V2-Paritätstest | Phase 8 |
| VISIONS V1.5 | Hybride Engine (Low-Latency + High-Quality, PDC) | V2 mit Offline-Identität |
| VISIONS V1.4 | WebGPU-Spektral-Effekte | optional als V2-Knoten, erst nach Benchmark |
| Main-TODO | audioEngine-Split | wird durch V2-Module überflüssig/ersetzt |
| Main-TODO | Worklet-CPU-/Underrun-Budgets | V2-Scheduler-Telemetrie |
| Main-TODO | Automation-Backpressure | bereits gebaut (`AutomationCoalescer`) → V2-Parameter |
| Main-TODO | Optionale Synthese (E-Piano, FM, Mod-Matrix usw.) | direkt als V2-Synth-Nodes bauen |
| RunPod-Branch | server-seitige AI-Generierung (Song/Voice/Sound/Stem) | V2 liefert Ergebnis-Audio an Client; AI bleibt Server |
| Hardware | HID/MIDI/OSC Control | V2-Parameter-Binding nutzen |

**Nicht gleichzeitig mitnehmen:**
- Hardware-B2–B7 (physische Module, NPU-Edge, etc.) – erst nach Software-Stabilität
- WebTransport/WebCodecs – erst bei >10 Usern/Bedarf
- Native Client (Tauri) – Browser-Grenzen erst real messen

## 6. Verifikation & Risiken

- **Risiko:** V2-Standard kann vor Parität zu stummem/regressivem Audio führen.
- **Gate:** erst wenn Phase 8 grün ist, wird V1 entfernt.
- `npm run verify` muss in jeder Phase grün bleiben (900+ Tests).
- Audio-Integrität: 0 zusätzliche Dropouts, Latenz 8–15 ms lokal.

## 7. Nächster Schritt

- **Phase 9 – V1 entfernen** (Gate ist zu: E2E-Live-Gate headed grün am 2026-09-09)
