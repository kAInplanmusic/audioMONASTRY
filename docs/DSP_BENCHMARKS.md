# DSP-Benchmarks (AM-E6-3)

> Gemessen mit `npx tsx scripts/dsp-benchmark.ts` in der Sandbox.
> 1.000.000 Iterationen je Kern. Stand: 2026-09-01.

| Benchmark | Zeit | Bewertung |
|---|---|---|
| `Math.pow(10, -db/20)` pro Sample | 73,4 ms | Referenz |
| Gain-LUT (1200 Einträge, 0,05 dB) | 40,0 ms | ✅ ~1,8× schneller |
| `20*Math.log10(peak)` pro Sample | 54,1 ms | Referenz |
| Peak-dB-LUT (8192 Einträge) | 21,7 ms | ✅ ~2,5× schneller |
| Biquad DF1 (5 Mul/4 Add) pro Sample | 65,0 ms | Referenz |
| Biquad DF1 im 128er-Block | 66,0 ms | ➖ kein Vorteil in JS (V8 optimiert bereits) |

## Erkenntnisse

1. **LUTs lohnen sich** für `Math.pow`/`Math.log10` in Hot-Paths:
   - `masteringProcessor` (AM-E1-3): Gain-/dB-Konversion auf LUT umstellen.
   - `effectProcessor.crush()` hat das bereits (vorberechnetes `crushLevels`).
2. **Block-Verarbeitung allein** bringt in V8 keinen messbaren Vorteil –
   entscheidend ist die Vermeidung von Allokationen/Closures im Block.
3. Weitere Benchmarks (FFT/Filter) folgen, sobald Spektral-Features eingeführt werden.

## AM-E4-2 FFT/iFFT-Evaluierung (dokumentiert 2026-09-03)

**Status:** Im Audio-Pfad existiert aktuell **keine eigene FFT** – FFTs laufen
nur UI-seitig (`PerformanceMonitorTerminal.simpleFft`, Radix-2, für Oszilloskop/
Spektrogramm). Für künftige Spektral-Features (Spektral-Analyse, Phase-Vocoder,
Convolution-Partitioning) gilt:
- **Kein Naive-DFT** in den Audio-Pfad. Für Power-of-2-Längen Radix-2/Radix-4
  mit Pre-Computed-Twiddle-Tables (keine `Math.cos`/`sin` im Hot-Path).
- Für Nicht-Power-of-2-Längen **cache-oblivious Mixed-Radix** (Bluestein nur
  als letzter Ausweg). Referenz: FFTW-Ansatz, KEIN Fremdcode.
- Evaluierung erfolgt erst mit Einführung des jeweiligen Features
  (Benchmark dann hier ergänzen, analog LUT-Tabelle oben).

## AM-E4-6 Oversampling-Evaluierung (dokumentiert 2026-09-03)

**Status:** `masteringProcessor` nutzt aktuell eine **2×-True-Peak-Schätzung
(linear)** – kein echtes Oversampling. Für nichtlineare Stufen (Soft-Clipper/
Sättigung) wird **Half-Band-Oversampling** evaluiert:
- Half-Band-FIR (2×) vor der Nichtlinearität, komplementärer Half-Band danach
  (Anti-Aliasing der erzeugten Harmonischen). CPU-Kosten ~2–3× des Kerns.
- Entscheidungskriterium: erst messen (`scripts/dsp-benchmark.ts`), dann
  einschalten. Ziel: THD-Verbesserung bei Sättigung, ohne CPU-Budget
  (< 70 % Gesamt) zu gefährden.
- Solange keine Sättigungsstufe im Produktivpfad liegt, bleibt es bei der
  linearen True-Peak-Schätzung (kein unnötiges Oversampling).

## P2-1 Resampling-Strategie & Filter-Qualität (dokumentiert 2026-09-03)

- **Browser:** Resampling macht der AudioContext (unsichtbar). Sample-Rate wird
  beim Context-Aufbau gesetzt (`createConfiguredAudioContext`); keine eigene
  SRC-Stufe im Audio-Pfad nötig.
- **EQ/Master-Filter:** Biquads (RBJ) mit Denormal-Guards; Worklet-Rampen sind
  statisch auditiert (`tests/workletRampAudit.test.ts`) – keine `Math.pow`/
  `new Array`/unerwartete `.push` im Hot-Path → zipper-frei.
- **Offen für später:** 2×-Oversampling in EQ/Master nur, falls Messungen
  (THD/CPU) das rechtfertigen; bis dahin bleiben die 12-Band-EQ-Kaskaden
  blockweise mit Rampen (kein hörbarer Zipper).
