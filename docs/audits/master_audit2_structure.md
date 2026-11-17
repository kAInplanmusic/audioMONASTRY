# audioMONASTRY — Phase C Audit 2 (Struktur): masterMONK

**Plugin:** `master` / `masterMONK`
**Stand:** Commit f5538c63
**Art:** Struktur-Audit — Architektur, Schnittstellen, Abhängigkeiten, Konsistenz.

---

## 1. Grundkonzept

Letzter Master-Insert der Kette (nach eq, dsp): Mastering-Dynamics mit Limiter, Kompressor, EQ, LUFS-Metering, 240 Frames (5 ms) Lookahead-Latenz — die einzige erklärte Systemlatenz.

## 2. Architektur-Analyse

**Schicht 1 — Vertrag (`src/plugins/pluginContract.ts`):**
- `id: 'master'`, `role: 'insert'`, `insertScope: 'master'`, `masterInserts[2]`
- `intrinsicLatencyFrames: 240` (5 ms bei 48 kHz, `MASTERING_LOOKAHEAD_SEC = 0.005`), `latencyNote` verweist auf `v2Pdc.ts`
- `bypassable: true`, `producesAudio: false`, `format: 'stereo'`, `inputs: 1`, `outputs: 1`

**Schicht 2 — UI (`src/components/master/MasterRack.tsx`):**
- Presets (`MASTERING_PRESETS` aus `data/masteringPresets.ts`), Input, Highpass, Tilt, Ziel-LUFS, Stärke, Attack, Release, Limiter-Ceiling, 12-Band-Klangbild, LUFS-Anzeige (`getLufsValue`, 250-ms-Intervall)
- Persistenz: `writePluginSettings('master')` (activePreset, masterMe, toneShift)

**Schicht 3 — Adapter (`src/plugins/adapters/MasterPluginAdapter.ts`):**
- Manifest: `kind: 'audio-processor'`, `latencySamples: 0`, `tailSamples: 0`
- `onProcess`: linearer Gain (`gain`-Parameter, 0–2), in-place, frühzeitiger Return bei 1.0
- `onParameter`: `masterVolumeDb` → `audioEngine.setMasterVolumeDb`; `inputGain` → `updateMasterMe`
- `onCommand preset`: `MASTERING_PRESETS` → `audioEngine.updateMasterMe` + `updateToneShiftEQ`

**Schicht 4 — Engine & C0:**
- `src/utils/audioEngine.ts`: `setMasterVolumeDb`, `updateMasterMe`, `updateToneShiftEQ`, `getLufsValue`
- `src/core/audio/C0StudioChain.ts`: `mastering = MasteringNode('master')` (240 Frames Lookahead-Zustand), `insertNodes.master = WorkletChainNode('chain:master','master')`, `WORKLET_BINDING.master = 'mastering-processor'`
- `src/core/audio/nodes/processingNodes.ts`: `MasteringNode` (Lookahead-Implementierung im C0-Graph, separat vom Adapter)

**Schicht 5 — Router (`src/core/pluginAudioRouter.ts`):**
- Zeile 72: `['master', 'ui-only', false]` → `isolation: 'ui-only'`, `mainFeeder: false`

**Schicht 6 — Signal chain & Bounce:**
- `src/plugins/signalChain.ts`: `masterInserts = ['eq','dsp','master']` (konsistent)
- `src/audio/pluginChainBounce.ts`: rendert alle Adapter; Master-Adapter = linearer Gain

## 3. Technische Fehlannahmen (Strukturell)

1. **Annahme: Der Vertrag beschreibt die tatsächliche DSP-Verarbeitung.** Der Vertrag verspricht einen Lookahead-Limiter mit 240 Frames; der Adapter implementiert linearen Gain. Der Vertrag ist nicht durch Code gedeckt.
2. **Annahme: `latencySamples: 0` im Manifest ist korrekt.** Der Vertrag selbst begründet 240 Frames Latenz; das Manifest behauptet 0. Widerspruch innerhalb der Adapter-Schicht.
3. **Annahme: Mastering-Zustand lebt im Adapter.** Presets, MasterMe, ToneShift leben in der UI und Engine; der Adapter ist zustandslos (außer Gain-Parameter).
4. **Annahme: Der Master-Insert ist der letzte Knoten der Kette.** `C0StudioChain` schaltet `itSynth` nach dem letzten Master-Insert vor den Recorder (Zeile 232–233) — nicht im Vertrag, nicht in `signalTopology()`.
5. **Annahme: Der Router spiegelt den Vertrag.** Router markiert master als `'ui-only'` (kein Audio-Graph), während Vertrag und C0 es als Audio-Insert einbauen.

## 4. Designschwächen

- **Drei Stellen für Mastering ohne Abstimmung.** Vertrag (Limiter, 240 Frames), UI (volle Kette), Adapter (Gain only) — keine kanonische Mastering-Implementierung.
- **Latenz ohne Verarbeitung.** 240 Frames werden deklariert, aber im Adapter gibt keine Lookahead-Pufferung. Das `MasteringNode` in C0 trägt den Lookahead-Zustand, aber der Adapter (Bounce-Pfad) kennt ihn nicht.
- **Preset-Pfad umgeht den Adapter.** `onCommand 'preset'` schreibt in die Engine, nicht in den Adapter. Bounce wendet Presets nicht an.
- **`itSynth` nach dem Master.** Nicht-vertraglicher Knoten zwischen Master und Recorder unterläuft die Ketten-Reihenfolge.
- **LUFS-Messung ohne Regelkreis.** Messung in der Engine, Anzeige in der UI, keine Rückkopplung auf Gain/Limiter.

## 5. Performance-/DSP-Risiken

- Adapter-Gain ist in-place, billig, kein Risiko — aber eben keine Mastering-Verarbeitung.
- Bei echter Limiter-Nachrüstung: Lookahead-Puffer (240 Frames) braucht `tailSamples` und konsistente PDC; aktuell `tailSamples: 0` im Manifest, was bei Lookahead falsch wäre (Tail nach Limiter-Release).
- Bounce ohne Limiter → gebounctes Master kann übersteuern (kein True-Peak-Ceiling im Offline-Pfad).
- LUFS-Intervall 250 ms im UI-Run, solange Rack offen — geringer Overhead, aber unnötig.

## 6. Schnittstellen-Probleme

| Schnittstelle | Zustand | Problem |
|---|---|---|
| Vertrag ↔ Adapter | Lookahead-Limiter, 240 Frames | linearer Gain 0–2 |
| Vertrag ↔ Manifest | `intrinsicLatencyFrames: 240` | `latencySamples: 0`, `tailSamples: 0` |
| UI ↔ Adapter | volle Mastering-Kette | Adapter erhält keine Parameter |
| Engine ↔ Adapter | Presets/MasterMe in Engine | Adapter nicht aktualisiert; Bounce ignoriert Presets |
| C0 ↔ Vertrag | Master-Insert letzte Position | `itSynth` nach Master (nicht vertraglich) |
| Vertrag ↔ Router | Insert Audio | `'ui-only'` (Zeile 72) |
| `MasteringNode` (C0) ↔ Adapter | beide beanspruchen Mastering | doppelte, nicht abgestimmte Implementierung |

## 7. Empfohlene Korrekturen

1. **Mastering-Adapter vollständig implementieren.** Limiter (mit Lookahead), Kompressor, EQ, True-Peak-Ceiling in `MasterPluginAdapter.onProcess`; `latencySamples` und `tailSamples` konsistent zu den 240 Frames setzen.
2. **Oder Latenz streichen.** Wenn kein Limiter kommt: `intrinsicLatencyFrames` auf 0, `MASTERING_LOOKAHEAD_SEC` entfernt, PDC-Versprechen zurückbauen.
3. **UI-Parameter in den Adapter leiten.** `setParameter` soll Gain, Limiter-Threshold, Comp-Parameter etc. an den Adapter übergeben, damit Live = UI = Bounce.
4. **Bounce konsistent.** Mastering-Zustand (Presets, Engine-Parameter) vor dem Bounce-Render anwenden oder Adapter vollständig.
5. **`itSynth` entfernen oder vertraglich verankern.** Der nicht-vertragliche Knoten nach dem Master-Insert muss raus oder in `signalTopology()` aufgenommen werden.
6. **Router konsistent.** `master` als Audio-Insert im Router oder Vertrag auf Nicht-Audio ändern.
7. **`MasteringNode` vs. Adapter klären.** Entweder C0-`MasteringNode` als Referenz für den Adapter nutzen oder eine der beiden Implementierungen entfernen (doppelte Zuständigkeit).
8. **LUFS-Regelkreis oder reine Anzeige.** Entweder automatische Gain-Korrektur zum Ziel-LUFS oder explizit als nicht-regierende Messung deklarieren.

**Fazit Struktur:** masterMONK hat einen Vertrag, der einen Lookahead-Limiter mit 240 Frames verspricht, und einen Adapter, der linearen Gain liefert. Dazu ein separates `MasteringNode` im C0-Graph und eine Mastering-UI, die weder in den Adapter noch in den Bounce einfließt. Die Struktur ist dreigeteilt und nicht konsistent; eine kanonische Mastering-Implementierung fehlt völlig.