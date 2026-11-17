# audit1_idea_destroyer — instruMONK (Plugin `inpro`, Kanal 5)

**Status:** abgeschlossen (adversarial / Idea Destroyer)  
**Basis:** `src/components/InstrumentsTerminal.tsx` (239 Zeilen), `src/plugins/adapters/InstruPluginAdapter.ts` (48 Zeilen), `src/plugins/pluginContract.ts` (Vertrag `instru`, role `source`, channel 5, stereo, `producesAudio: true`, `bypassable: true`, `intrinsicLatencyFrames: 0`)  
**Artefakte geprüft:** Hauptrepo + Worktree `audioMONASTRY-instru` (byte-identisch, md5-geprüft)

---

## 1. Grundkonzept

instruMONK ist das Instrumenten-Rack des Mixers: 50 akustische Presets (Soundfont/Sampler/Synth) plus synthetische Katalog-Instrumente (Analog/FM/Drums/FX), bedienbar über 5 Spielansichten (Noten, Tastatur, Pads, Canvas, GarageBand-Ansicht), MIDI Program Change via WebMIDI, Sample-Drop auf den aktiven Slot und ein globales `instrumentBackend`, das Noten (noteOn/noteOff) und Programm-Wechsel ausführt. Das Plugin besetzt Kanal 5, ist als `source` eingetragen, erzeugt Ton (`producesAudio: true`) und darf bypassed werden.

---

## 2. Architektur-Analyse

Das Konzept spaltet sich in drei lose gekoppelte Schichten:

1. **UI (`InstrumentsTerminal`)** — React-Komponente mit lokalem Zustand (`activeInstrument`, `playView`, `midiProgram`), liest/sichert Plugin-Settings (`readPluginSettings`/`writePluginSettings` für `instru`), verbindet `webMIDIAdapter`, rendert die 5 Ansichten über Kind-Komponenten (`UniversalKeyboard`, `PadGrid`, `InstrumentCanvas`, `GarageBandInstrumentView`).
2. **Backend (`instrumentBackend` / `InstrumentBackend`)** — globale, singleton-ähnliche Instanz, die über `import('../../core/instrument/InstrumentBackend')` geladen wird. Hält den aktuell geladenen Sound (`current()`), führt `load(id)`, `noteOn(note)`, `noteOff(note)`, `handleProgramChange(program)` aus.
3. **Audio-Engine (`audioEngine`)** — globaler Singleton (`import('../../utils/audioEngine')`), bietet `instrumentNote(note)` und `loadTrackSample(channel, url)`.

Kritisch: Es gibt **keine eigene DSP-Instanz pro Plugin**, obwohl der Vertrag `singleInstance: true` und eine eigene Latenz (`intrinsicLatencyFrames`) vorsieht. Das Plugin ist ein reiner UI-Controller über globale Singletons.

---

## 3. Technische Fehlannahmen

### Fehlannahme A: "Das Plugin besitzt Kanal 5 und spielt darauf"
Der Vertrag weist `instru` Kanal 5 zu (`channel: 5`, `viaChannel: true`). In der Realität spielt fast alles auf **Kanal 1**:
- `handleSampleDrop` ruft `audioEngine.loadTrackSample('channel1', sample.url)` (Zeile 162) — hardcodiert, ignoriert den zugewiesenen Kanal 5.
- `previewNote`/`releaseNote` rufen `instrumentBackend.noteOn/noteOff` ohne Kanal-Parameter — es gibt überhaupt keine Kanal-Zuordnung für Noten.
- Der Adapter (`InstruPluginAdapter.onCommand`, `note`) ruft `audioEngine.instrumentNote(note)` ebenfalls kanal-los.

Folge: Der Vertrags-Kanal 5 ist eine Fiktion. Die Summierung/Pan von instru landet nicht dort, wo der Mixer es erwartet.

### Fehlannahme B: "Produces Audio = eigener Knoten mit Latenz"
`producesAudio: true` und `singleInstance: true` suggerieren einen eigenen Audio-Graph-Knoten mit messbarer Latenz. Tatsächlich:
- `intrinsicLatencyFrames: 0` ist gelogen für Soundfont/Sampler-Instrumente, deren Sample-Laden asynchron ist und eine hörbare Latenz einführt.
- Es existiert kein Knoten, den man verzögern (PDC) oder bypassen könnte — PDC kann das Plugin nicht korrekt ausrichten.

### Fehlannahme C: "Bypass ist ein Dry/Wet-Crossfade"
Der Vertrag schreibt vor: Bypass ist ein latenztreuer Crossfade, kein Disconnect (`bypassable: true`). Die UI blendet bei Lock nur die ganze Komponente aus (`opacity: 0.5, grayscale`), und der Adapter hat gar keine Bypass-Logik. Ein echter Bypass-Crossfade existiert nicht.

### Fehlannahme D: "MIDI Program Change ist plugin-lokal"
WebMIDI Program-Change meldet sich bei `webMIDIAdapter.onControl` und ruft global `instrumentBackend.handleProgramChange(program)`. Das wechselt das Instrument **global**, für alle Instanzen/Nutzer, ohne Kanal-Kontext und ohne Rückfrage an den aktiven Halter (`lockStatus` wird nur geprüft, aber nicht durchgesetzt für den Wechsel selbst).

### Fehlannahme E: "FEAT-P3-002 optional-voice passt zu instru"
Der Befehl `optional-voice` hardcodiert `channel4` (Zeile 40) und ruft `audioEngine.setOptionalSynthVoice(channel, 'epiano', freq, ...)`. instru sitzt auf Kanal 5 — ein Widerspruch, der Stimmen auf dem falschen Kanal erzeugt.

---

## 4. Designschwächen

- **Gottes-Objekt `instrumentBackend`:** Keine Injektion, kein Interface, kein Mocking möglich. Unit-Tests des Terminals erfordern den echten Backend.
- **Globale Settings pro Tastendruck:** `writePluginSettings('instru', …)` wird bei jeder Änderung von `activeInstrument`/`activeCategory`/`playView` geschrieben (LocalStorage-Schreib-Last bei jeder Interaktion).
- **Fehlender Error-Context:** `instrumentBackend.load` Fehler werden mit `console.error` und leeren Catch-Blöcken (`catch(() => { /* Instrument nicht verfügbar */ })`) verschluckt; der Nutzer sieht nur "kein Instrument geladen".
- **Keine Kanal-Abstraktion:** Noten, Samples und Program-Change kennen keinen TrackType/Kanal — der Mixer-Kanal 5 aus dem Vertrag wird nirgends konsistent verwendet.
- **Sample-Drop vermischt Zustände:** `droppedSample` ist lokaler UI-Zustand, aber `loadTrackSample('channel1', …)` wirkt global auf audioEngine — kein Rollback bei Fehler.

---

## 5. Performance-/DSP-Risiken

| Risiko | Auswirkung |
|--------|------------|
| Asynchrones Sample-Laden ohne Latenz-Angabe | PDC kann nicht ausrichten; hörbare Versatz nach Preset-Wechsel |
| Kein eigener DSP-Node / Bypass-Crossfade | Bypass stummschaltet nur die UI, nicht das Audio; Klicks bei Preset-Wechsel möglich |
| Globales instrumentBackend als Single-Instance | Gleichzeitige Nutzer (webRTC) überschreiben sich gegenseitig das Instrument |
| Keine Sample-Vorladung / Cache für Soundfonts | Jeder Preset-Wechsel lädt neu, hörbare Pause |

---

## 6. Schnittstellen-Probleme

- Adapter `onCommand` empfängt `Record<string, unknown>` ohne Typ-Sicherheit; `program` wird mit `Number(…)` umgewandelt, ungültige Werte ergeben `NaN` ohne Validierung.
- `note` Befehl: `note as string | number` wird an `audioEngine.instrumentNote` gereicht — keine Absprache, welches Format die Engine erwartet.
- `import('../../core/instrument/InstrumentBackend')` und `import('../../utils/audioEngine')` sind lazy Imports innerhalb von `onCommand` — erste Ausführung löst Netzwerk/Code-Splitting aus, nicht deterministisch zeitbar (MIDI-Timing gefährdet).
- `webMIDIAdapter.connect()` wird bei jedem Mount versucht, Fehler werden verschluckt (`catch(() => {})`) — kein Hinweis, wenn MIDI nicht verfügbar ist.

---

## 7. Empfohlene Korrekturen

1. **Kanal-Konsistenz herstellen:** Alle Audio-Aufrufe (Sample-Drop, NoteOn, instrumentNote) müssen den vertraglich zugewiesenen Kanal (5) verwenden oder einen expliziten `TrackType`-Parameter erhalten. `channel1` hardcodiert entfernen.
2. **Echten DSP-Node mit Bypass-Crossfade einführen** oder den Vertrag anpassen (`producesAudio: false`, Rolle `utility`), damit PDC und Bypass ehrlich sind.
3. `intrinsicLatencyFrames` für Soundfont/Sampler messen und in `latencyNote` begründen (Vertrag fordert Begründung für Werte != 0).
4. `instrumentBackend` über ein Interface injizieren, damit das Plugin testbar ist und nicht globale Singleton-State teilt.
5. Bypass als Dry/Wet-Crossfade implementieren (kein reines UI-Opacity/Grayscale).
6. WebMIDI Program-Change kanal-basiert und unter Berücksichtigung von `lockStatus` (Halter-Prüfung) ausführen.
7. `optional-voice` entweder auf Kanal 5 umbiegen oder als separates Plugin ausweisen.
8. Fehler bei `instrumentBackend.load` sichtbar machen (UI-Feedback) statt stillschweigend zu ignorieren.
9. `writePluginSettings` nur bei echtem Wechsel debounced schreiben, nicht bei jedem Render-Zustandswechsel.
