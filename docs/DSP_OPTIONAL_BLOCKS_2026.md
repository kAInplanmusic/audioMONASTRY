# Optionale Synthese-/DSP-Bausteine (FEAT-P3-001)

Datum: 2026-09-11 · Bezug: `MASTERTODOENDE.json` → `FEAT-P3-001`

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

## Nicht gemacht (bewusst) → FEAT-P3-002

Die Bausteine sind **nicht** in den V2-Graph, die Plugin-UI oder das
Parameter-System verdrahtet. Das ist eine eigene Entscheidung (welche der 16
MONKs bekommt was, wie werden sie parametrisiert/persistiert, welcher UI-Pfad
zeigt sie) — als Folgeschritt `FEAT-P3-002` notiert, damit hier kein
Halbfertiges als fertig gilt.
