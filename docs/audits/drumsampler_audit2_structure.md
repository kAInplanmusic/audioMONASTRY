# Audit drumsampler — 2/2 Struktur-Audit (Architektur, Schnittstellen, Abhängigkeiten)

## Metadaten
- Plugin: drumsamplerMONK (id `drumsampler`, Rolle `source`, Kanal 3, Stereo, 0 In / 1 Out)
- Vertrag: `src/plugins/pluginContract.ts`; Registry: `src/plugins/registry.ts` (`drumsampler -> DrumMachineTerminal`); Signalkette: `src/plugins/signalChain.ts` (Stufe `sources`, nach `song`, vor `syntisampler`)
- Geprüfte Dateien: `src/components/DrumMachineTerminal.tsx` (446 Zeilen), Verweise auf `audioEngine`, `useMIDI`, `useMidiClockOut`, `DRUM_KITS` (`src/data/drumKits`), `captureDrumPatterns` (`src/core/capture/captureDrumPatterns`), `pluginSettings`, `SampleContext` (`useSamples`), `ALL_TRACKS` (`src/types`)
- Stand: gemischter Master-Tag gm-v1.0.0 / f5538c63

## 1. Grundkonzept
drumsamplerMONK ist ein 16/32-Step-Drum-Sequencer (TR-808-Schema) mit Kit-Auswahl (TR-808, TR-909, …), Sample-One-Shots pro Step, Pattern-Presets (FOUR/OFF/FILL/RANDOM), Bank A/B, Chain, Flam/Roll, Swing, MIDI-Out/Clock (24 PPQN + Note-Out) an externe Hardware und Capture-Übernahme von gespielten Mustern (`CAPTURE_DRUM_MERGE_EVENT`). Zustand wird in `pluginSettings('drumsampler')` persistiert. Steps triggern über den globalen Transport (`audioEngine.addStepListener`, `triggerDrumSound`).

## 2. Architektur-Analyse
**Komponenten-Hierarchie**: `DrumMachineTerminal` (`React.FC<DrumMachineProps>`, `React.memo`) ist ein großes, zustandsschweres Terminal (446 Zeilen) ohne Kind-Komponenten außer UI-Basisteilen (`AmCard`, `AmKnob`, `AmSeg`, `AmToggle`, `SampleModuleWrapper`, `DropTarget`). Es rendert Kit-Auswahl, Instrument-Kacheln, Klang-Werte, 16/32-Step-Raster, Pattern-Presets, Bank/Chain/Steps-Steuerung und eine Engine-Kanal-Pattern-Anzeige (nur Anzeige).

**State-Management**: Umfangreicher lokaler Zustand (`activeKit`, `selectedSoundId`, `patterns`, `stepSamples`, `flashId`, `currentStep`, `stepCount`, `bank`, `chain`, `flam`, `roll`, `swing`). Persistenz: Einmaliges Laden beim ersten Rendern über `useState(() => {...readPluginSettings('drumsampler')...})`; ein `useEffect` schreibt bei jeder Änderung von `activeKit`, `patterns`, `stepSamples` erneut `writePluginSettings('drumsampler', …)`.

**Datenfluss**: UI-Interaktion (Step-Toggle, Sample-Drop, Kit-Wechsel, Preset) → lokaler State + `audioEngine.setDrumKit` / `audioEngine.triggerDrumSound` / `audioEngine.recordDrumCapture`. Transport: `audioEngine.addStepListener(setCurrentStep)` liefert den aktuellen Step; bei `isPlaying` triggern Schritte Sounds (`trigger(s.id, accent)`) bzw. spielen Step-Samples ab (`playStepSample`). MIDI: `useMIDI()` / `useMidiClockOut(outputs)` für 24 PPQN + Note-Out. Fenster-Events: `monk:drum-pattern-random` (Zufallspatterns), `CAPTURE_DRUM_MERGE_EVENT` (Capture-Übernahme in Bank).

**Externe Abhängigkeiten**: `audioEngine` (globale Quelle, `setDrumKit`, `triggerDrumSound`, `recordDrumCapture`, `addStepListener`, `addPatternListener`, `getSequencerPatterns`, `setSwing` — Signaturen nicht in diesem Plugin typisiert), `useMIDI`/`useMidiClockOut` (WebMIDI, nicht in jedem Browser), `DRUM_KITS` (statische Kit-Daten im Bundle), `captureDrumPatterns` (Merge-Logik für Capture), `pluginSettings` (Persistenz), `useSamples` (`addSample`, `pendingSample`, `takeoverRequest`), `webRTCManager.userId` (Lock-Vergleich), `isTrustedMediaUrl` (Sample-URL-Allowlist).

**Vertragsbindung**: `pluginContract.ts` deklariert `drumsampler` als Quelle (Kanal 3, Stereo, bypassable, sendsToFx post, syncCapable, producesAudio, Latenz 0 ohne `latencyNote`). `signalChain.ts` ordnet es der Stufe `sources` zu. `registry.ts` mappt `drumsampler -> DrumMachineTerminal`. Keine dieser Dateien erwähnt Kits, Patterns, MIDI oder den Sequencer.

## 3. Technische Fehlannahmen
1. **Vertrag `intrinsicLatencyFrames: 0` vs. Sequencer-Scheduling**: Ein Step-Sequencer hat inhärente Scheduling-Latenz (Schritt-Raster auf Transport-Ticks). Der Vertrag behauptet Latenz 0; der Code plant über `currentStep % stepCount` und `audioEngine.addStepListener` (UI-Thread-Event), keine Sample-genaue Scheduling-Anbindung an die Audio-Clock. Swing und Flam (30 ms) sind willkürliche Offsets ohne Latenz-Kompensation.
2. **`producesAudio: true` vs. Implementierung**: drumsampler löst nur Trigger aus (`triggerDrumSound`); die Samples/Sounds werden von `audioEngine` bzw. `DRUM_KITS` abgespielt. Das Plugin selbst erzeugt kein Audio.
3. **`viaChannel: true / Kanal 3`**: Keine Abbildung, welcher Vertragskanal (3) die Drum-Sounds bespielt. `triggerDrumSound(activeKit, soundId, velocity, 'drum-step')` hat keinen Kanal-Parameter; die Kanalzuordnung zu Vertragskanal 3 ist undokumentiert.
4. **`syncCapable: true`**: MIDI-Out geht an externe Hardware, aber ob das Plugin selbst gegen Main syncet (UI2-P0-003) und wie die Step-Position mit der PDC kompensiert wird, ist unklar.
5. **Patterns persistieren ohne Limit**: `writePluginSettings` schreibt das gesamte Patterns/stepSamples-Objekt bei jeder Änderung. Bei großen Pattern-Banken (Kit × Sound × Steps) ist das ein wachsender JSON-Block im plugin-Speicher ohne Größenlimit oder Versionierung.

## 4. Designschwächen
- **Write-Strom bei jeder Interaktion**: `useEffect(() => { writePluginSettings('drumsampler', {kit, patterns, stepSamples}) }, [activeKit, patterns, stepSamples])` feuert bei jedem Step-Toggle, jedem Sample-Drop, jedem Preset. Kein Debounce, kein Batch-Schreiben, kein „nur bei explizitem Save“. Das blockiert den Hauptthread und nutzt den Speicher unnötig.
- **Zwei unabhängige Taktquellen**: `currentStep` kommt von `audioEngine.addStepListener` (externer Schritt-Tick) in lokalen State; parallel läuft `midiOut.clockOut` mit eigenem `setBpm`/`start`/`emitStep` (24 PPQN). Engine-Listener und MIDI-Uhr können auseinanderlaufen; Drift zwischen visueller Anzeige (`stepNow`), MIDI-Out und Audio-Trigger möglich.
- **Flam/Roll über `setTimeout` im Render-Effekt**: `setTimeout(..., 30)` und `[40, 80]` ms für Roll sind nicht an die Audio-Clock gebunden; bei Tab-Hintergrund oder Frame-Drops verschieben sich die Nachschläge hörbar.
- **`enginePatterns` nur Anzeige (Einbahnstraße)**: `getSequencerPatterns?.()` wird einmalig beim Mount gelesen und über `addPatternListener` aktualisiert, aber es gibt keinen Rückweg von der UI-Pattern-Ansicht in den Engine-Sequencer (außer Capture-Merge). Die Engine-Kanal-Patterns sind rein lesbar.
- **Sample-Drop ohne Validierung beim Ablegen**: `handleSampleDrop(sample, step)` legt ein `AudioSample` unter `stepSamples[key][step]`, prüft aber nur beim Abspielen (`playStepSample` → `isTrustedMediaUrl`), nicht beim Ablegen. Ungültige/unsichere URLs landen im State und werden beim Abspielen still verworfen.
- **Kein Undo/Redo**: Jeder Step-Toggle überschreibt den State sofort; keine Historie.

## 5. Performance-/DSP-Risiken
- **MIDI-Clock läuft parallel zum Transport**: `midiOut.clockOut.start(step, now)` und `emitStep` bei jedem Schritt; `setBpm(bpm)` im Effect bei jeder BPM-Änderung kann die MIDI-Uhr neu starten, was Noten verschluckt oder doppelt sendet.
- **Keine Polyphonie-/Stimmen-Limitierung**: Bei FILL-Preset (alle Steps an) und mehreren Sounds gleichzeitig triggert `triggerDrumSound` pro Schritt alle aktiven Sounds; keine Maximalstimmen, kein Stealing, kein Gain-Staging der Summe → Clipping-Risiko bei vollen Patterns.
- **`DRUM_KITS` statisch im Bundle**: Alle Kits und Sounds sind im Client-Bundle enthalten; große Sample-Sets würden den Bundle aufblähen (kein Lazy-Loading der Kits).
- **Step-Rendering teuer**: Jeder Schritt ist ein `DropTarget` + Button mit inline-`style` (`--c`). Bei 32 Steps × viele Sounds × Re-Render bei jeder Pattern-Änderung teures DOM-Reconciliation.

## 6. Schnittstellen- und Abhängigkeits-Probleme
- `audioEngine.triggerDrumSound(activeKit, soundId, velocity, source)`: Signatur nicht typisiert in diesem Plugin; `source` String (`'drum-step'`, `'drum-pad'`, `null`) ist eine magische Konvention. `recordDrumCapture` ähnlich undefiniert.
- `captureDrumPatterns` (`CAPTURE_DRUM_MERGE_EVENT`, `mergeCaptureDrumHits`) wird über ein globales `window`-Event angestoßen; `detail.handled = true` wird gesetzt, aber nie geprüft, ob ein anderer Listener das Event bereits behandelt hat (Doppel-Übernahme möglich).
- `useMIDI()` / `useMidiClockOut(outputs)` — WebMIDI API, nicht in jedem Browser verfügbar; `midiOut.connected` kann false sein, das Plugin degraded still (MIDI OUT Toggle zeigt OFF, kein Fehler im UI).
- `DRUM_KITS` und `TYPE_COLORS` sind harte In-Code-Daten; neue Kits erfordern Code-Änderung und Neubau, keine JSON-/Preset-Erweiterung zur Laufzeit.
- Vertrag und Plugin sind entkoppelt: `pluginContract.ts` weiß nichts von Kits, Patterns, MIDI; `registry.ts` mappt nur die Komponente.
- `registry.ts` COMPONENT_MAP und `pluginContract.ts` PLUGIN_CONTRACTS sind doppelte Quellen für id → Rolle/Component; sie können auseinanderdriften.

## 7. Empfohlene Korrekturen
1. `intrinsicLatencyFrames` begründen (Sequencer-Scheduling-Latenz) bzw. Step-Trigger sample-genau an die Audio-Clock (`AudioContext.currentTime` / v2Pdc) binden; Swing/Flam als latenzkompensierte Offsets.
2. `producesAudio` auf `false` korrigieren (Trigger-Client, keine eigene Quelle) oder eigene Sample-Wiedergabe einbauen.
3. `writePluginSettings` debouncen (z. B. 300 ms, leading/trailing) und nur bei explizitem „Speichern“ oder unload; Pattern-Größe begrenzen/versionieren.
4. Taktquelle vereinheitlichen: entweder Engine-Listener ODER MIDI-Clock als Master, nicht beides parallel; Drift zwischen Playhead und Trigger vermeiden.
5. Flam/Roll `setTimeout` durch audio-Clock-basiertes Scheduling ersetzen.
6. Sample-Drop bei Ablegen validieren (`isTrustedMediaUrl`), ungültige Samples ablehnen statt still zu verwerfen.
7. Maximalstimmen und Gain-Staging für die Drum-Summe nachrüsten; Kits lazy-laden und als externe Presets laden statt hart im Bundle.
8. Vertrag/Registry um Kit/MIDI/Sequencer-Eigenschaften ergänzen oder dokumentieren, dass drumsampler rein ein UI-Trigger-Client ist.
