# Optionale Synthese-/DSP-Bausteine (FEAT-P3-001 + FEAT-P3-002)

Datum: 2026-09-11 · Bezug: `MASTERTODOENDE.json` → `FEAT-P3-001`, `FEAT-P3-002`

Vier Bausteine, die vorher fehlten, als **reine, getestete Kerne** — ohne
Audio-Kontext, ohne DOM, ohne UI. Damit ist die Klanglogik prüfbar (nicht nur
„läuft ohne Fehler") und die Entscheidung, ob/wie sie in den V2-Graph kommen,
bleibt offen statt in der Verdrahtung versteckt.

| Baustein | Datei | Zweck | Kern API |
|---|---|---|---|
| **Modulations-Matrix** | `src/core/dsp/modMatrix.ts` | Quellen (LFO/Env/Feature/CC) auf Ziele routen, Tiefe/Polarität, Summe je Ziel | `applyModMatrix(routes, sources, opts)` · `applyModulationToParameters(base, …)` |
| **Phase-Distortion** | `src/core/dsp/phaseDistortion.ts` | Casio-CZ-Klangfarben (harte Leads/Bässe) ohne Filter | `shapePhase` · `phaseDistortionSample` · `renderPhaseDistortion` · `highFrequencyEnergy` |
| **E-Piano (FM)** | `src/core/dsp/electricPiano.ts` | FM-Stimme mit Glockenanschlag → Sustain | `renderElectricPiano(freq, opts)` · `pianoSampleCount` · `rmsOf` |
| **HQ-Reverb (FDN)** | `src/core/dsp/hqReverb.ts` | 4-Leitungs-FDN mit Dämpfung und RT60-Regelung | `new HighQualityReverb(opts)` · `process(block)` · `reset()` · `renderReverbImpulse` |

## Verifikation (17 Tests, `tests/optionalDspBlocks.test.ts`)

Geprüft wird die **Wirkung**, nicht nur die Lauffähigkeit:

- **Matrix**: Summe mehrerer Quellen auf ein Ziel; bipolar (0..1 → −1..1);
  unbekannte Quelle/deaktivierte Route/Tiefe 0/NaN werden **gemeldet**
  (`skipped`) statt still Null zu addieren; Tiefe und Ergebnis geklemmt.
- **Phase-Distortion**: `amount = 0` ist bit-genau der Sinus; `amount = 0.9`
  (Säge-Verlauf) hat > 2× so viel Oberwellenenergie (Energie der ersten
  Ableitung); bleibt in −1..1, kein NaN, auch bei Unsinns-Eingaben.
- **E-Piano**: Länge = Dauer×Rate; Hüllkurve fällt über drei Zeitfenster
  (Anschlag → Sustain → Ausklang); ohne FM-Index fast oberwellenfrei, mit Index
  deutlich glockig; Dauer auf 60 s begrenzt, Pegel ≤ 1.
- **HQ-Reverb**: `mix = 0` ist das trockene Signal; Impulsantwort klingt über
  drei Fenster ab; bei RT60 = 30 s und 400 Blöcken stabil (kein Aufschaukeln,
  kein NaN); kurzes RT60 klingt schneller ab als langes; `reset()` hinterlässt
  keinen Resthall.

## Verdrahtung im V2-Pfad, Plugin-UI und Persistenz (FEAT-P3-002)

Die vier Kerne sind jetzt angebunden — mit einer **Produktentscheidung** je
Baustein und ohne die V2-Parität zu verändern, solange sie aus sind:

| Baustein | MONK | Art | Wo im Pfad |
|---|---|---|---|
| Modulations-Matrix | `dsp` | Prozessor | Master-Kette: LFO → Master-Gain (`ModMatrixNode`) |
| HQ-Reverb | `effect` | Prozessor | Master-Kette nach dem DSP-Filter (`HqReverbNode`) |
| Phase-Distortion | `syntisampler` | Quelle | V2-Synth-Stimme `phase` (Step-Bursts) |
| E-Piano (FM) | `instru` | Quelle | V2-Synth-Stimme `epiano` (Step-Bursts) |

1. **V2-Graph (hörbar).** `src/core/audio/nodes/optionalDspNodes.ts` implementiert
   die beiden Prozessoren als `IAudioNode`; `V2MonitorGraph` hängt sie zwischen
   DSP- und FX-Insert (`master:mod-matrix` → `master:hq-reverb`). Beide sind
   **bit-transparent**, wenn sie aus sind (Default) — getestet, nicht behauptet.
   Die beiden Quellen laufen als zusätzliche Stimmen in `V2SinkEngine.renderStepBurst`
   (`V2SynthVoice` + `amount`/`modIndex` über die Port-Nachricht `synth-source`).
2. **Steuerung bis in den Audio-Thread.** `V2SinkEngine.setMasterModMatrix/…`,
   `V2LiveSink.setMasterModMatrix/setMasterReverb/setSynthSource`, die
   Worklet-Nachrichten `master-mod-matrix`/`master-reverb` in `v2SinkProcessor.ts`
   und `audioEngine.setOptionalModMatrix/setOptionalReverb/setOptionalSynthVoice`
   (mit `resetOptionalSynthVoice` als Rückweg).
3. **Preset-Schema (Persistenz).** `src/core/dsp/dspPresets.ts` ist die einzige
   Quelle für Defaults, Wertebereiche und die MONK-Zuordnung; unbekannte
   Bausteine/Parameter werfen, Werte außerhalb des Bereichs werden geklemmt und
   gemeldet. `serialize/parseOptionalDspPresets` schreiben/lesen JSON. Ein Test
   hält die Engine-Defaults und das Schema synchron (keine Drift).
4. **Plugin-Adapter.** `dspMONK`/`effectMONK` reichen Parameter (`modEnabled`,
   `modRate`, `modDepth`, `reverbEnabled/-Mix/-DecayS/-Damping/-SizeScale`) und
   `optional-dsp`-Kommandos an den Audio-Pfad durch; `syntisamplerMONK`/`instruMONK`
   schalten die Quellen über `optional-voice`.
5. **UI-Pfad.** `src/components/dsp/OptionalDspPanel.tsx` (vier Panels im
   `DSPTerminal`) schreibt in den hörbaren Pfad und persistiert lokal; jeder
   Panel-Kopf zeigt den zugeordneten MONK.

**Belege:** `tests/optionalDspWiring.test.ts` (15 Tests) misst am **V2SinkEngine** —
dieselbe Engine, die der `v2-sink-processor` im AudioWorklet hostet: Hall-Tail
nach Ton aus (mit Reverb), Tremolo-Hub (mit Mod-Matrix), hörbare Phase-/
E-Piano-Bursts, Bypass bit-transparent, Schema-Klemmen/-Werfen, Adapter-Delegation.
`scripts/audio-gate.cjs` prüft dasselbe im **echten Browser am echten Worklet**:
Hall-Tail −35,0 dBFS (aus: wieder Stille), Tremolo-Hub 27,0 dB (aus: wieder
Stille), plus die bisherigen Pegel-/Kanalzusagen — GATE: PASS. Volle Gates:
`tsc 0`, `eslint 0`, Boundary 407/0, `test:ci` 1241/1241 ohne Skips.

