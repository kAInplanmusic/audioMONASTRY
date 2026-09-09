# V1_DEPENDENCY_MAP — Nachweis der V1-Abhängigkeiten

> Stand: 2026-09-09 · Erstellt vor dem V1-Cutover (Phase 9)
> Klassifikation: REMOVE / MIGRATE / KEEP-BUT-NOT-AUDIO / KEEP

## 1. Zusammenfassung

| Kategorie | Anzahl | Status |
|---|---|---|
| Dateien mit `Tone.`-Referenzen | 12 (154 Treffer in audioEngine.ts) | MIGRATE / KEEP-BUT-NOT-AUDIO |
| Dateien mit `from 'tone'`-Import | 5 | MIGRATE / KEEP-BUT-NOT-AUDIO |
| Dateien mit `utils/audioEngine`-Import | 35 | KEEP (V2-Engine-Facade) |
| V1-Feature-Flags (`playbackMode 'v1'`, `VITE_V2_AUDIO_ONLY`) | entfernt | REMOVE ✅ |
| GraphEngineAdapter | entfernt | REMOVE ✅ |
| V1-Worklet-Direktverdrahtung (audioEngine.init) | 1 (audioEngine.ts) | MIGRATE |

## 2. Detailtabelle

| Datei | Symbol | Nutzung | Runtime-Relevanz | Ersatz | Status |
|---|---|---|---|---|---|
| src/utils/audioEngine.ts | `Tone.Volume/Player/MembraneSynth/Transport/now` (154×) | V1-Monolith: Channel-Gains, Sample-Player, Synths, Transport | **KRITISCH** – Live-Pfad der 35 Importeure | V2StudioGraph + V2LiveSink + GraphPlaybackEngine | MIGRATE (teiloffen) |
| src/utils/audioEngine.ts | `GraphEngineAdapter` | deprecated V1→V2-State-Sync | keine (nie im Live-Pfad) | `syncV2FromV1()` direkt | REMOVE ✅ |
| src/utils/audioEngine.ts | `playbackMode === 'v1'`-Zweige | V1-Transport | deaktiviert (Mode immer 'v2') | V2-Zweig | REMOVE (Flag) / MIGRATE (Zweige) |
| src/utils/v2FeatureFlags.ts | `VITE_V2_AUDIO_MODE='v1'`, `isV1PlaybackAllowed` | V1-Feature-Flag | entfernt | V2-only | REMOVE ✅ |
| src/core/audio/compat/GraphEngineAdapter.ts | Klasse | V1↔V2-Adapter | keine | – | REMOVE ✅ |
| tests/graphEngineAdapter.test.ts | Test | Adapter-Test | – | – | REMOVE ✅ |
| src/context/AudioContext.tsx | `Tone.getContext`, `Tone.start` (16×) | App-Init (User-Geste) | Start des AudioContext | native `AudioContext` via Factory | KEEP-BUT-NOT-AUDIO (Init-Adapter) |
| src/core/WebAudioBackend.ts | `Tone` (3×) | IAudioBackend-Referenz | Backend-Adapter | native WebAudio | KEEP-BUT-NOT-AUDIO |
| src/components/SettingsDialog.tsx | `Tone` (1×) | Latenz-Hint an Tone-Context | nicht im Renderpfad | native `AudioContext.latencyHint` | KEEP-BUT-NOT-AUDIO |
| src/components/SpatialScene.tsx | `Tone` (1×) | Spatial-UI | nicht im Renderpfad | – | KEEP-BUT-NOT-AUDIO |
| src/data/instrumentSynths.ts, drumKits.ts, core/interfaces.ts, workletInitializers.ts, itSynthProcessor.ts, clockProcessor.ts | `Tone`-Typannotation/Kommentar (je 1×) | Typen/Kommentare | keine | – | KEEP-BUT-NOT-AUDIO |
| 35 Dateien mit `import { audioEngine }` | `audioEngine` | Terminal-/Plugin-API | **KRITISCH** – gesamte UI | `audioV2TerminalBridge` (aktuell Alias) | KEEP (Facade), langfristig V2-native API |
| src/core/audio/compat/V2TerminalBridge.ts | `syncV2FromV1` | V1→V2-Sync vor Terminal-Aktionen | aktiv im V2-Modus | entfällt nach V2-nativem State | MIGRATE |
| src/core/audio/worklets/*.ts | V1-Worklet-Prozessoren | DSP-Code | **KRITISCH** – von WorkletGraphRuntime/V2LiveSink genutzt | bleiben (sind V2-DSP) | KEEP |
| src/audio/worklets/*.ts | Worklet-Quellen | DSP-Prozessoren | **KRITISCH** – V2-WorkletChain | bleiben | KEEP |

## 3. Klassifikation der kritischen Audio-Pfade

- **REMOVE:** GraphEngineAdapter + Test, V1-Feature-Flags, V1-Mode-Zweige (Logik unerreichbar).
- **MIGRATE → V2:** audioEngine-Monolith (Tone-Nodes/Transport). Der V2-Pfad (V2StudioGraph/V2LiveSink/GraphPlaybackEngine/V2SampleClock) ist aktiv und per Live-Gate verifiziert; die 35 Importeure laufen über die `audioEngine`-Facade, die den V2-Graph speist. Die vollständige Tone-Entfernung aus dem Monolith erfordert die Portierung der verbleibenden Terminal-API (Kanalzüge, Sample-Player, DJ-Deck, Synth-Trigger) auf V2-Nodes — als offener P1-Backlog geführt.
- **KEEP-BUT-NOT-AUDIO:** Tone-Referenzen in Init-/UI-/Typ-Kontexten (blockieren den Render-Thread nicht).
- **KEEP:** V2-Worklets, GraphStateBridge, MonitorRouting, V2-Live-Sink.

## 4. Fazit

Das V2-Live-Audio-Gate ist **grün** (headed, echter AudioWorklet-Pfad). Der V1-Cutover wurde eingeleitet:
1. V1-Feature-Flags entfernt (Mode ist immer `v2`).
2. GraphEngineAdapter entfernt.
3. 16-MONK-Registry und System-Module sind verbindlich.

**Verbleibend (P1):** Tone.js-Abhängigkeit im `audioEngine`-Monolith vollständig durch V2-Nodes ersetzen und `tone` aus `package.json` entfernen, sobald keine Runtime-Nutzung mehr besteht.
