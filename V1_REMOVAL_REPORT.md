# V1_REMOVAL_REPORT — Phase 9 Readiness Gate

> Erstellt: 2026-09-10 · Branch: main @ 9f8e2ef · Methode: Code-Import-Analyse + Test-/Build-Verifikation + Live-Gate.
> Regel: V1 wird NUR gelöscht, wenn V2 nachweislich Parität für jeden produktionskritischen V1-Pfad hat. „Tests grün" allein reicht nicht.

## 1. Ergebnis

**Deletion readiness: NOT READY**

Phase 9 („V1 entfernen") darf in der aktuellen Form NICHT fortgesetzt werden.
Der destruktive Schritt wurde **nicht** ausgeführt.

Begründung in einem Satz: Der V2-Live-Pfad trägt aktuell nur Gain/Pan/Master/Monitor/2.1 — Drum-Synthese, EQ, DSP, FX, Dynamics, Mastering, Mute/Solo, Trigger/Preview/Instrument-Audio und der Master-Stream-Tap sind im V2-Pfad stumm oder unwirksam; die „V1-Entfernung" wurde bisher über eine No-Op-Facade (`nativeAudioKit`) erreicht, nicht über echte V2-Parität.

## 2. V1-Komponenten-Inventar

| V1-Komponente | Produktions-Referenzen | Test-Referenzen | V2-Ersatz | Parität | Lösch-Risiko | Erforderliche Migration | Safe to delete? |
|---|---|---|---|---|---|---|---|
| `tone` (npm) | 0 Importe | 0 | `nativeAudioKit` (Facade) | n/a (Paket entfernt) | kein | – | ✅ bereits entfernt |
| `GraphEngineAdapter` | 0 | 0 | `syncV2FromV1()` direkt | vollständig | kein | – | ✅ bereits entfernt |
| V1-Feature-Flags (`VITE_V2_AUDIO_MODE='v1'`, `isV1PlaybackAllowed`) | nur defensive API | `tests/v2Phase7.test.ts` | `resolvePlaybackMode` erzwingt `v2` | vollständig | kein | Flags dokumentieren | ✅ Flag-Logik bereits entfernt |
| V1-Transport-Zweige in `audioEngine` (`play/stop/tick/processEvent` else-Pfade) | unerreichbar (Mode immer `v2`) | 0 | V2-Transport via `v2LiveSink` | vollständig (Code tot) | gering | Zweige löschen | ✅ nach AUDIO-P0-004 |
| `kickSynth/hatSynth/clapSynth/bassSynth` (Membrane/Metal/Noise/Mono via `nativeAudioKit`) | `init()`/`tick()` (toter Pfad) | 0 | **FEHLT**: V2-Sink rendert 440-Hz-Sinus-Burst je Kanal | ❌ nicht vorhanden | **hoch** | Drum-Synthese in `V2SinkEngine`/`v2SinkProcessor` portieren (AUDIO-P0-001) | ❌ NEIN |
| `Tone.Player`-Sample-Preview (`previewSample(url)`) | `LibraryTerminal` u. a. | 0 | **FEHLT**: No-Op; V2-Sink kann Samples, aber Preview-Pfad nutzt ihn nicht | ❌ nicht vorhanden | **hoch** | Preview auf `v2LiveSink.setSampleBuffer`+`triggerSample` umstellen (AUDIO-P0-003) | ❌ NEIN |
| `playSynthesisInstrument`/`itSynthNode`-Verdrahtung | `InstrumentsTerminal` | `tests/instrumentCores.test.ts` (nur Cores) | **PARTIAL**: Worklet existiert, Ausgang hängt an No-Op-`Tone.Gain`/Kanalzug | 🟡 Worklet ja, hörbar nein | **hoch** | it-synth-Ausgang in V2-Sink/V2-Graph einspeisen (AUDIO-P0-003) | ❌ NEIN |
| `triggerEvent` (Pad-/Manuell-Trigger) | `McpTerminal` Z. 111 u. a. | 0 | **FEHLT**: `graphPlayback.trigger()` rendert offline, Ausgabe geht nirgends hin | ❌ nicht vorhanden | **hoch** | `triggerEvent` → `v2LiveSink.triggerSample`/Step-Event (AUDIO-P0-003) | ❌ NEIN |
| Legacy-Worklet-Kette in `init()` (effect→dynamics→eq→mastering→dsp→lufs→analyzer→destination) | `init()` (läuft bei jedem Start) | indirekt (Analyzer/LUFS-Telemetrie) | **PARTIAL**: V2-Nodes existieren (`processingNodes.ts`), aber nicht im Live-Graph; Kette ist eingangsseitig stumm | 🟡 Nodes ja, Live-Wirkung nein | **hoch** | EQ/DSP/FX/Dynamics/Mastering in `V2SinkEngine`/`V2MonitorGraph` aufnehmen; Analyzer/LUFS an V2 hängen (AUDIO-P0-004) | ❌ NEIN (erst umbauen) |
| `masterStreamTap` (Master-Stream/SFU) | `useMasterStream.ts`, `createMasterStreamDestination()` | 0 | **FEHLT**: Tap hängt am stummen Legacy-Ende; `v2LiveSink` geht direkt an `ctx.destination` | ❌ nicht vorhanden | **kritisch** | V2-Ausgang in `masterStreamTap` einspeisen (AUDIO-P0-002) | ❌ NEIN |
| Mute/Solo (Kanal-Stummschaltung) | `mutedStems` in `audioEngine` | `tests/monitorRouting.test.ts` (Zustand) | **FEHLT** im V2-Sink: `syncV2FromV1` überträgt keine Mutes; Worklet spielt Patterns unabhängig von `mutedStems` | ❌ nicht vorhanden | hoch | Mute/Solo in `V2SinkEngine`/`syncV2FromV1` (AUDIO-P0-004) | ❌ NEIN |
| Seek (`Tone.Transport.seconds` setzen) | `AudioContext.tsx` (Clock-Sync) | 0 | **PARTIAL**: `V2SampleClock` kennt nur `reset()`; kein Seek | 🟡 fehlt | mittel | Seek-API in `V2SampleClock`/Sink (P1) | ❌ NEIN (P1) |
| `src/audio/worklets/*` (V1-Worklet-Prozessoren) | WorkletGraphRuntime/OfflineBounce/Parity-Tests | viele | bleiben als V2-DSP-Nodes | ✅ | kein | – | ✅ KEEP |
| `audioEngine.ts` (3444 LOC, 35+ Importeure) | **KRITISCH**: gesamte UI/Adapter | `tests/audioEngine.test.ts` u. a. | `audioV2TerminalBridge` = Alias auf dieselbe Facade | n/a (Facade) | **kritisch** | Split nach AUDIO-P1-002; NICHT löschen | ❌ NEIN |

## 3. Zählwerk

- V1-Produktionsabhängigkeiten (noch aktiv, unersetzbar): **35+ Importeure der `audioEngine`-Facade + 4 stumme/fehlende V2-Pfade (Drum-Synth, Trigger/Preview/Instrument, EQ/DSP/Mastering-Live, Master-Stream-Tap)**
- V1-Testabhängigkeiten: **gering** (kein Test braucht den echten V1-Mode; `v2Phase7` testet nur die Flag-API)
- V1-unaufgelöste Features (im V2-Live-Pfad fehlend): **8** (Drum-Synthese, EQ, DSP, FX, Dynamics, Mastering, Mute/Solo, Seek; dazu Trigger/Preview/Instrument hörbar, Master-Stream)
- V2-Parität (Live-Pfad, ehrlich): **≈ 45 %** (Transport, Sample-Clock, Patterns, Sample-Playback, Gain/Pan, Master-Gain, Monitor-Plan, 2.1-Crossover funktionieren; Processing/Stimmen/Stream fehlen)
- **Deletion readiness: NOT READY**

## 4. Was bereits sicher entfernt wurde (Bestand, verifiziert)

1. `tone` aus `package.json`/`node_modules` — 0 Importe, Build/Test grün.
2. `GraphEngineAdapter` + `tests/graphEngineAdapter.test.ts` — 0 Referenzen.
3. V1-Feature-Flag-Logik — `resolvePlaybackMode` erzwingt `'v2'`.

## 5. Warum „Tests grün" hier trügt

- Die Unit-/Parity-Tests prüfen Offline-Renderer und Zustände (`OfflineBounceEngine`, `GraphStateBridge`, Worklet-Klassen isoliert). Sie prüfen NICHT, ob der **Live-AudioWorklet-Pfad** die Processing-Nodes enthält.
- Das Live-Gate (`v2-live.spec.ts`) verifiziert nur `playing=true` + `v2Connected=true` — nicht den hörbaren Inhalt (kein Audio-Capture/Assertion auf Nicht-Stille oder Frequenzinhalt).
- No-Op-Fassaden (`nativeAudioKit`) liefern Zustandswerte, die Tests grün machen, ohne dass Audio fließt.

## 6. Nächste Schritte (Blocking Tasks)

1. AUDIO-P0-001 (Drum-Synthese in V2-Sink) — Voraussetzung für alles Weitere.
2. AUDIO-P0-004 (Processing-Nodes in V2-Live-Graph: EQ/DSP/FX/Dynamics/Mastering + Mute/Solo).
3. AUDIO-P0-002 (Master-Stream-Tap an V2-Ausgang).
4. AUDIO-P0-003 (Trigger/Preview/Instrument hörbar).
5. Danach: AUDIO-P1-001 (tote V1-Zweige löschen) → AUDIO-P1-003 (No-Op-Facade aus Live-Pfad) → AUDIO-P1-002 (Facade-Split).
6. Erneutes Readiness-Gate mit Audio-Capture-Tests (Nicht-Stille + Spektrum je Rolle/Effekt).
