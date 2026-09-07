# audioEngine-Split-Plan (3294 Zeilen → Module)
# ==============================================
# Stand: 2026-09-07
# Ziel: AudioEngine in logische Module aufteilen (Split 1–3)

## Verteilung

### Module (bereits existierend oder neu)

1. **src/core/audio/backends/**
   - `WebAudioWorkletBridge.ts` (bereits existierend)
   - `WasmBackend.ts` (neu, für WASM-Kernel)
   - `AudioBackend.ts` (Interface: setup, process, teardown)

2. **src/core/audio/worklets/**
   - `DSPWorklet.ts` (DSP-Knoten)
   - `EQWorklet.ts` (EQ-Knoten)
   - `MasteringWorklet.ts` (Mastering-Knoten)
   - `LUFSWorklet.ts` (LUFS-Monitoring)
   - `AnalyzerWorklet.ts` (Waveform-Analyse)
   - `workletSpecs.ts` (Werklet-Definitionen + Registry)

3. **src/core/audio/routing/**
   - `pluginChannelMap.ts` (bereits existierend)
   - `monitorRouting.ts` (Monitor-Plan)
   - `routingValidator.ts` (neue Validierung)

4. **src/core/audio/plugins/**
   - `pluginChannelMap.ts` (re-used)
   - `pluginAudioChannels.ts` (Kanal-Zuordnung pro Plugin)

5. **src/core/audio/compat/**
   - `GraphEngineAdapter.ts` (bereits existierend)
   - `GraphPlaybackEngine.ts` (bereits existierend)

6. **src/core/audio/graph/**
   - `V2StudioGraph.ts` (bereits existierend)
   - `GraphStateBridge.ts` (bereits existierend)
   - `WorkletGraphRuntime.ts` (bereits existierend)
   - `audioGraphSerialization.ts` (Serialisierung)

7. **src/audio/bounce/**
   - `OfflineBounceEngine.ts` (bereits existierend)

8. **src/core/audio/state/**
   - `ClockSync.ts` (bereits existierend)
   - `PhaseLockedLoop.ts` (bereits existierend)
   - `AudioIdleDetector.ts` (Neu)
   - `adaptiveLatency.ts` (Neu)
   - `telemetry.ts` (Neu)

## Split-Phasen

### Phase 1: Backends & Worklets (diese Session)
- [ ] `AudioBackend.ts` Interface erstellen (20 Zeilen)
- [ ] `WasmBackend.ts` implementieren (200 Zeilen, aus WebGPUKernel)
- [ ] `DSPWorklet.ts` aus audioEngine.ts extrahieren (400 Zeilen)
- [ ] `EQWorklet.ts` (100 Zeilen)
- [ ] `MasteringWorklet.ts` (150 Zeilen)
- [ ] `LUFSWorklet.ts` (100 Zeilen)
- [ ] `AnalyzerWorklet.ts` (100 Zeilen)

### Phase 2: Routing & State (nächste Session)
- [ ] `pluginChannelMap.ts` prüfen (bereits existierend)
- [ ] `monitorRouting.ts` prüfen (bereits existierend)
- [ ] `routingValidator.ts` extra prüfen
- [ ] `AudioIdleDetector.ts` (neu)
- [ ] `AdaptiveLatencyController.ts` (bereits existierend)
- [ ] `telemetry.ts` (bereits existierend)

### Phase 3: Graph & Compatibility (folgende Session)
- [ ] `V2StudioGraph.ts` prüfen (bereits existierend)
- [ ] `GraphStateBridge.ts` prüfen (bereits existierend)
- [ ] `WorkletGraphRuntime.ts` prüfen (bereits existierend)
- [ ] `audioGraphSerialization.ts` prüfen (bereits existierend)
- [ ] `GraphEngineAdapter.ts` prüfen (bereits existierend)
- [ ] `GraphPlaybackEngine.ts` prüfen (bereits existierend)

### Phase 4: Composite Entry (letzte Session)
- [ ] `audioEngine.ts` als Composite schreiben (Import aller Module)
- [ ] Alle Abhängigkeiten bereinigen
- [ ] Tests prüfen (audioEngine.test.ts muss weiterlaufen)
- [ ] Verzeichnis strukturieren (keine Verlagerung von `utils/` → alles bleibt)

## Risikoanalyse

- **Hoch:** AudioEngine integrierter Kern; Fehlfunktion = keine Audio-Ausgabe
- **Mittel:** viele direkte Abhängigkeiten (Tone.js, Web Audio API)
- **Niedrig:** Module sind entkoppelt; Backends können isoliert getestet werden

## Verifikation

- `npm run verify` muss grün bleiben (842 Tests, 141 Files)
- `npm run build` muss erfolgreich sein
- `npm run test:audio` muss alle Audio-Tests bestehen

## Timeline

- Phase 1: 30–45 Minuten (diese Session)
- Phase 2: 30 Minuten (nächste Session)
- Phase 3: 30 Minuten
- Phase 4: 15 Minuten
- **Gesamt:** ~1.5 Stunden (inkl. Testing & Commit/Push)

## Kompatibilität

- Keine API-Änderungen → `audioEngine.ts` bleibt identisch
- Nur interne Refaktorierung
- Tests müssen unverändert laufen
