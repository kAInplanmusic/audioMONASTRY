# DSP-Paritäts-Toleranzen V1 ↔ V2

> Zweck: Dokumentiert mathematisch, wo V1 (Tone.js-/Worklet-Referenz) und V2
> (AudioGraph-Nodes) absichtlich voneinander abweichen und warum diese
> Abweichung akzeptiert wird. Alle Tests referenzieren diese Datei.
> Stand: 2026-09-09 · Basis: `tests/v2DspParityExtended.test.ts`

## 1. Exakte Parität (Toleranz ≤ 1e-6, sample-level)

| Baustein | V1-Referenz | V2-Node | Toleranz |
|---|---|---|---|
| Gain (dB → linear) | `Tone.Gain` / mathematische Referenz `10^(dB/20)` | `GainNode` | ≤ 1e-7 |
| Stereo-Pan | Equal-Power-Gesetz `lg=cos((p+1)π/4)`, `rg=sin((p+1)π/4)` | `StereoPanNode` | ≤ 1e-7 |
| EQ 0 dB (V2) | – (Bypass-Koeffizienten `[1,0,0,0,0]`) | `ParametricEqNode` | exakt transparent (≤ 1e-6) |
| Dynamics Bypass | `DynamicsProcessor` `enabled=false` | `DynamicsNode` `enabled=0` | bit-identisch |
| Automation (linear) | `AudioParameter` Interpolation | identisch | ≤ 1e-5 |

## 2. Dokumentierte Abweichungen (absichtlich)

### 2.1 V1-EQ bei 0 dB (RBJ-Shelf-Degeneration)

**Beobachtung:** Der V1-`EqProcessor` (RBJ-Shelf-/Peaking-Biquads) ist bei
0 dB Band-Gain nicht exakt transparent. Ursache: Die RBJ-Shelf-Gleichung
degeneriert bei `A=10^(0/40)=1` nicht zu `H(z)=1`, weil `b1` und `a1`
unterschiedliche Terme behalten (`b1=-4·cos(ω)/a0` vs. `a1=-4/a0`).
Gemessene maximale Sample-Abweichung bei 1 kHz/-0 dBFS-Sinus (512 Samples):
**≤ 0.1** (Peak), typisch < 0.09.

**V2-Verhalten:** `computeBiquadCoefficients` gibt für `|gainDb| < 1e-9`
explizit `[1,0,0,0,0]` zurück (ARCH-AUDIO-002-Fix). V2 ist bei 0 dB exakt
transparent. Die Abweichung V1↔V2 bei neutralem EQ ist damit auf die
V1-Degeneration begrenzt und beträgt **≤ 0.1** (Peak, dokumentiert).

### 2.2 Dynamics (Kompressor) V1 ↔ V2

**V1:** `DynamicsProcessor` arbeitet in der dB-Domain mit eigenem
Envelope-Follower (Attack/Release-Smoothing, optionale Gate-/Hold-Stufen).

**V2:** `DynamicsNode` nutzt eine Peak-Envelope in der linearen Domain mit
identischer statischer Kompressorkurve (`compressorCurveDb`) und
Attack/Release-Koeffizienten.

**Toleranz:** RMS-Pegelabweichung bei gleichen Parametern
(threshold -18 dB, ratio 4, attack 10 ms, release 100 ms, knee 6 dB,
makeup 0 dB, 60-Hz-Sinus, 0.95 Amplitude, 2048 Samples) **≤ 10 dB**.
Beide Pfade erfüllen die Eigenschafts-Parität: Peaks ≤ 1.0, keine Clips,
hörbares Material. Die Abweichung resultiert aus der Envelope-Domain
(dB vs. linear), nicht aus der statischen Kurve.

### 2.3 Mastering (Limiter) V1 ↔ V2

**V1:** `MasteringProcessor` – Lookahead-Limiter mit programmabhängiger
Release-Rampe, `ceiling`-Clamp.

**V2:** `MasteringNode` – Peak-Tracker mit `ceiling`-Clamp und
Compressor-Kurve, Release-Smoothing.

**Toleranz:** Es wird bewusst KEINE Sample-Parität getestet (unterschiedliche
Limiter-Topologien). Geprüft werden Eigenschaften: Peaks ≤ `ceiling`+1e-3,
Stille bleibt Stille, NaN/Inf-Freiheit.

## 3. Nicht tolerierte Abweichungen (harte Gates)

- Stille-Eingang ⇒ Stille-Ausgang (alle Nodes, bit-identisch)
- NaN/Inf im Eingang ⇒ endlicher Ausgang (Guard-Pflicht)
- Denormale (1e-30) ⇒ kein NaN/Inf
- Kanalzahl: Stereo = 2, 2.1 = 3 (L/R/LFE), N.x = N
- PDC: Step-Frame = Referenz-Frame − Lookahead-Samples (exakt)
