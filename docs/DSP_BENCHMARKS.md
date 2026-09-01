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
