# Audit drumsampler — 1/2 Idea Destroyer (adversarial)

## Metadaten
- Plugin: drumsamplerMONK (id `drumsampler`, Rolle `source`, Kanal 3, Stereo)
- Vertrag: `src/plugins/pluginContract.ts` (`intrinsicLatencyFrames: 0`, `bypassable: true`, `sendsToFx: true` / `fxSendTap: 'post'`, `syncCapable: true`, `viaChannel: true`, `producesAudio: true`)
- Geprüfte Dateien: `src/components/DrumMachineTerminal.tsx`, `src/plugins/registry.ts` (`drumsampler -> DrumMachineTerminal`), Verweise auf `audioEngine`, `useMIDI`, `useMidiClockOut`, `DRUM_KITS`, `captureDrumPatterns`, `pluginSettings`
- Stand: gemischter Master-Tag gm-v1.0.0 / f5538c63

## 1. Grundkonzept
drumsamplerMONK ist ein 16/32-Step-Drum-Sequencer (TR-808-Schema) mit Kit-Auswahl (TR-808, TR-909, …), Sample-One-Shots pro Step, Pattern-Presets (FOUR/OFF/FILL/RANDOM), Bank A/B, Chain, Flam/Roll, Swing, MIDI-Out/Clock (24 PPQN + Note-Out) an externe Hardware und Capture-Übernahme von gespielten Mustern (`CAPTURE_DRUM_MERGE_EVENT`). Zustand wird in `pluginSettings('drumsampler')` persistiert. Steps triggern über den globalen Transport (`audioEngine.addStepListener`, `triggerDrumSound`).

## 2. Architektur-Analyse
`DrumMachineTerminal` ist ein großes, zustandsschweres React-Terminal (446 Zeilen). Es verwaltet Kit, Sounds, Patterns (`Record<string, boolean[]>`), Step-Samples, Bank, Chain, Flam, Roll, Swing, stepCount (16|32), und hört auf `audioEngine`-Step-/Pattern-Listener. Side Effects: `audioEngine.setDrumKit` (einmalig), `writePluginSettings` bei jeder Änderung von `activeKit`/`patterns`/`stepSamples`, MIDI-Clock (`midiOut.clockOut`), Fenster-Events (`monk:drum-pattern-random`, `CAPTURE_DRUM_MERGE_EVENT`). Kein eigener DSP; Trigger gehen über `audioEngine.triggerDrumSound` / `recordDrumCapture`.

## 3. Technische Fehlannahmen
1. **„intrinsicLatencyFrames: 0“** — Ein Step-Sequencer hat inhärente Scheduling-Latenz (Schritt-Raster auf Transport-Ticks). Der Vertrag behauptet Latenz 0; der Code plant über `currentStep % stepCount` und `audioEngine.addStepListener` (UI-Thread-Event), keine Sample-genaue Scheduling-Anbindung an die Audio-Clock. Swing und Flam (30 ms) sind willkürliche Offsets ohne Latenz-Kompensation.
2. **„producesAudio: true“** — drumsampler löst nur Trigger aus (`triggerDrumSound`); die Samples/Sounds werden von `audioEngine` bzw. `DRUM_KITS` abgespielt. Das Plugin selbst erzeugt kein Audio.
3. **„viaChannel: true / Kanal 3“** — Keine Abbildung, welcher Vertragskanal (3) die Drum-Sounds bespielt. `triggerDrumSound(activeKit, soundId, velocity, 'drum-step')` hat keinen Kanal-Parameter; die Kanalzuordnung zu Vertragskanal 3 ist undokumentiert.
4. **„syncCapable: true“** — MIDI-Out geht an externe Hardware, aber ob das Plugin selbst gegen Main syncet (UI2-P0-003) und wie die Step-Position mit der PDC kompensiert wird, ist unklar.
5. **„Patterns persistieren“** — `writePluginSettings` schreibt das gesamte Patterns/stepSamples-Objekt bei jeder Änderung. Bei großen Pattern-Banken (Kit × Sound × Steps) ist das ein wachsender JSON-Block im plugin-Speicher ohne Größenlimit oder Versionierung.

## 4. Designschwächen
- **Write-Strom bei jeder Interaktion**: `useEffect(() => { writePluginSettings('drumsampler', {kit, patterns, stepSamples}) }, [activeKit, patterns, stepSamples])` feuert bei jedem Step-Toggle, jedem Sample-Drop, jedem Preset. Kein Debounce, kein Batch-Schreiben, kein „nur bei explizitem Save“. Das blockiert den Hauptthread und nutzt den Speicher-Speicher unnötig.
- **`currentStep` kommt von `audioEngine.addStepListener` (externer Schritt-Tick)** und wird in lokalen State geschrieben; parallel läuft `midiOut.clockOut` mit eigenem `setBpm`/`start`/`emitStep`. Zwei unabhängige Taktquellen (Engine-Listener + MIDI-Clock) können auseinanderlaufen; der visuelle Playhead (`stepNow`) und das tatsächliche Triggeren (`triggerDrumSound` im selben Effect) basieren auf derselben `currentStep`, aber die MIDI-Uhr tickt unabhängig (24 PPQN) — Drift zwischen visueller Anzeige, MIDI-Out und Audio-Trigger möglich.
- **`triggerDrumSound` im Render-Effekt mit `setTimeout` für Flam/Roll**: `setTimeout(..., 30)` und `[40, 80]` ms für Roll sind nicht an die Audio-Clock gebunden; bei Tab-Hintergrund oder Frame-Drops verschieben sich die Nachschläge hörbar.
- **`enginePatterns` nur Anzeige**: `getSequencerPatterns?.()` wird einmalig beim Mount gelesen und über `addPatternListener` aktualisiert, aber es gibt keinen Rückweg von der UI-Pattern-Ansicht in den Engine-Sequencer (außer Capture-Merge). Die Engine-Kanal-Patterns sind eine Einbahnstraße.
- **Sample-Drop ohne gültige Zuordnung**: `handleSampleDrop(sample, step)` legt ein `AudioSample` unter `stepSamples[key][step]`, prüft aber nur `isTrustedMediaUrl` beim Abspielen (`playStepSample`), nicht beim Ablegen. Ungültige/unsichere URLs landen im State und werden beim Abspielen still verworfen.
- **Kein Undo/Redo für Pattern-Änderungen**: Jeder Step-Toggle überschreibt den State sofort; keine Historie.

## 5. Performance-/DSP-Risiken
- **MIDI-Clock läuft parallel zum Transport**: `midiOut.clockOut.start(step, now)` und `emitStep` bei jedem Schritt; bei vielen Steps und BPM-Änderungen (`setBpm` im Effect bei jeder BPM-Änderung) kann die MIDI-Uhr neu gestartet werden, was Noten verschluckt oder doppelt sendet.
- **Keine Polyphonie-/Stimmen-Limitierung**: Bei FILL-Preset (alle Steps an) und mehreren Sounds gleichzeitig triggert `triggerDrumSound` pro Schritt alle aktiven Sounds; keine Maximalstimmen, kein Stealing, kein Gain-Staging der Summe → Clipping-Risiko bei vollen Patterns.
- **`DRUM_KITS` statisch im Bundle**: Alle Kits und Sounds sind im Client-Bundle enthalten; große Sample-Sets würden den Bundle aufblähen (kein Lazy-Loading der Kits).
- **Step-Rendering**: Jeder Schritt ist ein `DropTarget` + Button mit inline-`style` (`--c`). Bei 32 Steps × viele Sounds × Re-Render bei jeder Pattern-Änderung teures DOM-Reconciliation.

## 6. Schnittstellen-Probleme
- `audioEngine.triggerDrumSound(activeKit, soundId, velocity, source)`: Signatur nicht typisiert in diesem Plugin; `source` String `'drum-step'` vs `'drum-pad'` vs `null` ist eine magische Konvention. `recordDrumCapture` ähnlich undefiniert.
- `captureDrumPatterns` (`CAPTURE_DRUM_MERGE_EVENT`, `mergeCaptureDrumHits`) wird über ein globales `window`-Event angestoßen; `detail.handled = true` wird gesetzt, aber nie geprüft, ob ein anderer Listener das Event bereits behandelt hat (Doppel-Übernahme möglich).
- `useMIDI()` / `useMidiClockOut(outputs)` — WebMIDI API, nicht in jedem Browser verfügbar; `midiOut.connected` kann false sein, das Plugin degraded still (MIDI OUT Toggle zeigt OFF, kein Fehler im UI).
- `DRUM_KITS` und `TYPE_COLORS` sind harte In-Code-Daten; neue Kits erfordern Code-Änderung und Neubau, keine JSON-/Preset-Erweiterung zur Laufzeit.
- Vertrag und Plugin sind entkoppelt: `pluginContract.ts` weiß nichts von Kits, Patterns, MIDI; `registry.ts` mappt nur die Komponente.

## 7. Empfohlene Korrekturen
1. `intrinsicLatencyFrames` begründen (Sequencer-Scheduling-Latenz) bzw. Step-Trigger sample-genau an die Audio-Clock (`AudioContext.currentTime` / v2Pdc) binden; Swing/Flam als latenzkompensierte Offsets.
2. `producesAudio` auf `false` korrigieren (Trigger-Client, keine eigene Quelle) oder eigene Sample-Wiedergabe einbauen.
3. `writePluginSettings` debouncen (z. B. 300 ms, leading/trailing) und nur bei explizitem „Speichern“ oder unload; Pattern-Größe begrenzen/versionieren.
4. Taktquelle vereinheitlichen: entweder Engine-Listener ODER MIDI-Clock als Master, nicht beides parallel; Drift zwischen Playhead und Trigger vermeiden.
5. Flam/Roll `setTimeout` durch audio-Clock-basiertes Scheduling ersetzen.
6. Sample-Drop bei Ablegen validieren (`isTrustedMediaUrl`), ungültige Samples ablehnen statt still zu verwerfen.
7. Maximalstimmen und Gain-Staging für die Drum-Summe nachrüsten; Kits lazy-laden und als externe Presets laden statt hart im Bundle.
8. Vertrag/Registry um Kit/MIDI/Sequencer-Eigenschaften ergänzen oder dokumentieren, dass drumsampler rein ein UI-Trigger-Client ist.
