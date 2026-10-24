/**
 * tests/dspKernelWasm.test.ts
 * ===========================
 * ZUK-003 – Konformitäts- und Paritätstests für den DSP-Kern
 * (`src/audio/wasm/dspKernel_rs` + `src/audio/wasm/dspKernelWasm.ts`).
 *
 * Aufbau: die Prüfungen laufen als EINE Suite gegen zwei Implementierungen
 * (`DspKernelLike`):
 *
 *   1. `ReferenceDspKernel` – die TS-Referenz, immer verfügbar.
 *   2. `DspKernelWasm`      – nur, wenn `public/wasm/dspKernel.wasm` die
 *                             Prozessor-Exporte (ABI v2) enthält. Fehlt das
 *                             `wasm32-unknown-unknown`-Target, ist das
 *                             ausgelieferte Modul noch ABI v1; der Block wird
 *                             dann mit Begründung übersprungen (kein Fake-Build).
 *
 * Orakel sind bewusst NICHT die Implementierung selbst, sondern
 *   * geschlossene Textbook-Werte des RBJ-Biquads bei z = ±1
 *     (TP: 1/0, HP: 0/1, BP: 0/0),
 *   * die Schranken/Monotonie von tanh,
 *   * die Ein-Pol-Sprungantwort (63,2 % nach einer Zeitkonstante) und die
 *     statische Kompressor-Kennlinie GR = (T − L)(1 − 1/ratio).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ReferenceDspKernel,
  type CompressorParams,
  type DspKernelLike,
  type FilterParams,
} from '../src/audio/wasm/dspReference';
import { DspKernelWasm } from '../src/audio/wasm/dspKernelWasm';

const SR = 48000;
const BLOCK = 128;

// ---------------------------------------------------------------------------
// WASM-Verfügbarkeit (synchron geprüft: WebAssembly.Module ist ein Konstruktor)
// ---------------------------------------------------------------------------

const wasmPath = path.resolve(process.cwd(), 'public/wasm/dspKernel.wasm');
const wasmBytes = readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmExportNames = WebAssembly.Module.exports(wasmModule).map((e) => e.name);

const PROCESSOR_EXPORTS = [
  'dsp_filter_set',
  'dsp_filter_reset',
  'dsp_filter_process',
  'dsp_saturate_set',
  'dsp_saturate_process',
  'dsp_comp_set',
  'dsp_comp_reset',
  'dsp_comp_process',
  'dsp_comp_gain_db',
] as const;

const HAS_PROCESSORS = PROCESSOR_EXPORTS.every((n) => wasmExportNames.includes(n));

/** Fehlt das Target, baut niemand ein echtes Modul – der Skip sagt das laut. */
const WASM_SKIP_REASON =
  'public/wasm/dspKernel.wasm ist ABI v1 (kein dsp_filter_process) – das '
  + 'wasm32-unknown-unknown-Target fehlt. Neu bauen: '
  + '`rustup target add wasm32-unknown-unknown && cd src/audio/wasm/dspKernel_rs && '
  + 'cargo build --release --target wasm32-unknown-unknown`. Bis dahin prüft die '
  + 'TS-Referenz (dspReference.ts) dieselben Algorithmen gegen dieselben Orakel.';

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

type KernelFactory = () => Promise<DspKernelLike>;

/** Führt `total` Samples durch den Filter, erzeugt die Eingabe per `gen`. */
function runFilter(
  kernel: DspKernelLike,
  total: number,
  gen: (i: number) => number,
): Float32Array {
  const out = new Float32Array(total);
  for (let off = 0; off < total; off += BLOCK) {
    const n = Math.min(BLOCK, total - off);
    const inL = new Float32Array(n);
    const inR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = gen(off + i);
      inL[i] = v;
      inR[i] = v;
    }
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    kernel.processFilter(inL, inR, outL, outR);
    out.set(outL.subarray(0, n), off);
  }
  return out;
}

/**
 * Stationärer Betrag bei einer Eigenfrequenz des Systems.
 * DC  (z = +1): konstantes Eingangssignal 1.0
 * Nyq (z = −1): alternierendes Eingangssignal ±1.0
 * Beides sind Eigenfunktionen eines stabilen LTI-Systems, der stationäre
 * Ausgang ist also exakt H(±1) * Eingang.
 */
function steadyStateGain(
  kernel: DspKernelLike,
  params: FilterParams,
  atNyquist: boolean,
  total = 24000,
): number {
  kernel.setFilter(params);
  kernel.resetFilter();
  const gen = atNyquist ? (i: number) => (i % 2 === 0 ? 1 : -1) : () => 1;
  const out = runFilter(kernel, total, gen);
  const last = out[total - 1];
  // Bei Nyquist alterniert der Ausgang mit dem Eingang → Vorzeichen zurück.
  const sign = atNyquist && (total - 1) % 2 !== 0 ? -1 : 1;
  return last * sign;
}

/** Amplitude im stationären Teil bei einer Sinus-Anregung. */
function sineAmplitude(
  kernel: DspKernelLike,
  params: FilterParams,
  freq: number,
  total = 48000,
): number {
  kernel.setFilter(params);
  kernel.resetFilter();
  const out = runFilter(kernel, total, (i) => Math.sin((2 * Math.PI * freq * i) / SR));
  let peak = 0;
  for (let i = Math.floor(total / 2); i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  return peak;
}

function lp(cutoff: number, q = 0.70710678): FilterParams {
  return { kind: 'lowpass', sampleRate: SR, cutoff, q };
}

/** Statische Gain-Reduktion nach der Kennlinie (Orakel). */
function expectedStaticGrDb(levelDb: number, thresholdDb: number, ratio: number): number {
  return levelDb > thresholdDb ? (thresholdDb - levelDb) * (1 - 1 / ratio) : 0;
}

// ---------------------------------------------------------------------------
// Gemeinsame Konformitäts-Suite
// ---------------------------------------------------------------------------

function conformanceSuite(label: string, make: KernelFactory): void {
  describe(`DSP-Kern – ${label}`, () => {
    let kernel: DspKernelLike;
    const setup = async () => {
      kernel = await make();
    };

    // --- Biquad: DC / Nyquist ---------------------------------------------
    describe('Biquad-Magnitude bei DC und Nyquist', () => {
      const cases: Array<[string, FilterParams]> = [
        ['LP 1 kHz Q0.707', { kind: 'lowpass', sampleRate: SR, cutoff: 1000, q: 0.70710678 }],
        ['LP 200 Hz Q10', { kind: 'lowpass', sampleRate: SR, cutoff: 200, q: 10 }],
        ['HP 1 kHz Q0.707', { kind: 'highpass', sampleRate: SR, cutoff: 1000, q: 0.70710678 }],
        ['HP 8 kHz Q4', { kind: 'highpass', sampleRate: SR, cutoff: 8000, q: 4 }],
        ['BP 1 kHz Q4', { kind: 'bandpass', sampleRate: SR, cutoff: 1000, q: 4 }],
        ['LP 1 kHz @44.1k', { kind: 'lowpass', sampleRate: 44100, cutoff: 1000, q: 0.70710678 }],
      ];

      const expected: Record<string, [number, number]> = {
        lowpass: [1, 0],
        highpass: [0, 1],
        bandpass: [0, 0],
      };

      it.each(cases)('%s trifft die Textbook-Werte', async (_name, params) => {
        await setup();
        const [dcExpected, nyExpected] = expected[params.kind];
        const dc = steadyStateGain(kernel, params, false);
        const ny = steadyStateGain(kernel, params, true);
        expect(Math.abs(dc - dcExpected)).toBeLessThan(1e-3);
        expect(Math.abs(ny - nyExpected)).toBeLessThan(1e-3);
      });

      it('Bandpass hat 0 dB Spitze bei der Mittenfrequenz', async () => {
        await setup();
        const amp = sineAmplitude(kernel, { kind: 'bandpass', sampleRate: SR, cutoff: 1000, q: 4 }, 1000);
        expect(Math.abs(amp - 1)).toBeLessThan(0.02);
      });

      it('Lowpass dämpft oberhalb der Grenzfrequenz um mind. 12 dB/Oktave-Naeherung', async () => {
        await setup();
        const below = sineAmplitude(kernel, lp(1000), 500);
        const above = sineAmplitude(kernel, lp(1000), 4000);
        // 2 Oktaven über fc: RBJ-Filter 2. Ordnung liegt dort deutlich unter -20 dB.
        expect(below).toBeGreaterThan(0.9);
        expect(above).toBeLessThan(0.1);
      });
    });

    // --- Sättigung ---------------------------------------------------------
    describe('Sättigung (tanh)', () => {
      const satIn = (x: number) => Float32Array.from([x]);
      const zero = Float32Array.from([0]);

      it('ist monoton steigend und auf |trim| beschränkt', async () => {
        await setup();
        kernel.setSaturation({ drive: 4, trim: 0.5 });
        const outL = new Float32Array(1);
        const outR = new Float32Array(1);
        let prev = -Infinity;
        for (let x = -6; x <= 6; x += 0.01) {
          kernel.processSaturation(satIn(x), satIn(x), outL, outR);
          expect(outL[0]).toBeGreaterThanOrEqual(prev - 1e-7);
          expect(Math.abs(outL[0])).toBeLessThanOrEqual(0.5 + 1e-6);
          prev = outL[0];
        }
      });

      it('bleibt auch bei absurden Amplituden endlich und beschränkt', async () => {
        await setup();
        kernel.setSaturation({ drive: 100, trim: 0.25 });
        const big = Float32Array.from([1e6, -1e6, 1e30, -1e30, Number.NaN, Number.POSITIVE_INFINITY]);
        const outL = new Float32Array(big.length);
        const outR = new Float32Array(big.length);
        kernel.processSaturation(big, big, outL, outR);
        for (const v of outL) {
          expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(v)).toBeLessThanOrEqual(0.25 + 1e-6);
        }
      });

      it('hat die Kleinsignalverstaerkung drive*trim', async () => {
        await setup();
        kernel.setSaturation({ drive: 4, trim: 0.5 }); // slope(0) = 2.0
        const x = 1e-4;
        const outL = new Float32Array(1);
        const outR = new Float32Array(1);
        kernel.processSaturation(satIn(x), zero, outL, outR);
        expect(outL[0] / x).toBeCloseTo(2, 2);
        kernel.processSaturation(zero, zero, outL, outR);
        expect(outL[0]).toBe(0);
      });
    });

    // --- Kompressor --------------------------------------------------------
    describe('Kompressor (stereo-verkoppelt)', () => {
      const params: CompressorParams = {
        sampleRate: SR,
        threshold: -20,
        ratio: 4,
        attack: 0.01,
        release: 0.2,
      };
      const STEP = 0.5; // -6,02 dBFS

      /** Verarbeitet `n` Samples einer Konstantspannung, gibt die Ausgänge zurück. */
      const stepBlock = (n: number, amp = STEP, ampR = amp) => {
        const inL = new Float32Array(n).fill(amp);
        const inR = new Float32Array(n).fill(ampR);
        const outL = new Float32Array(n);
        const outR = new Float32Array(n);
        kernel.processCompressor(inL, inR, outL, outR);
        return { outL, outR };
      };

      it('reduziert den Pegel und trifft nach der Attack-Zeit 63,2 % des Ziels', async () => {
        await setup();
        kernel.setCompressor(params);
        kernel.resetCompressor();
        expect(kernel.compressorGainDb()).toBe(0);

        const levelDb = 20 * Math.log10(STEP);
        const target = expectedStaticGrDb(levelDb, params.threshold, params.ratio);
        expect(target).toBeLessThan(-10); // Testannahme: klarer Überschuss

        const nAttack = Math.round(params.attack * SR); // 480
        stepBlock(nAttack);
        const grAtAttack = kernel.compressorGainDb();

        // Ein-Pol: nach genau einer Zeitkonstante 1 - 1/e = 63,2 % des Ziels.
        expect(grAtAttack / target).toBeGreaterThan(0.6);
        expect(grAtAttack / target).toBeLessThan(0.67);

        // Nach 8 Zeitkonstanten ist das Ziel praktisch erreicht.
        stepBlock(nAttack * 7);
        expect(Math.abs(kernel.compressorGainDb() - target)).toBeLessThan(0.05);
      });

      it('verstärkt nicht und schwingt nicht über', async () => {
        await setup();
        kernel.setCompressor(params);
        kernel.resetCompressor();
        const { outL } = stepBlock(SR / 2, STEP);
        const gain = outL[outL.length - 1] / STEP;
        expect(gain).toBeLessThan(1);
        expect(gain).toBeGreaterThan(0);
        expect(kernel.compressorGainDb()).toBeLessThanOrEqual(0);
      });

      it('lässt Signale unter dem Threshold unverändert', async () => {
        await setup();
        kernel.setCompressor(params);
        kernel.resetCompressor();
        const quiet = 0.05; // -26 dBFS < -20 dBFS
        const { outL, outR } = stepBlock(4800, quiet, -quiet);
        for (let i = 0; i < outL.length; i++) {
          expect(outL[i]).toBeCloseTo(quiet, 6);
          expect(outR[i]).toBeCloseTo(-quiet, 6);
        }
        expect(kernel.compressorGainDb()).toBe(0);
      });

      it('verkoppelt stereo: der lautere Kanal steuert beide', async () => {
        await setup();
        kernel.setCompressor(params);
        kernel.resetCompressor();
        stepBlock(24000, 0.01, 0.5);
        const linked = kernel.compressorGainDb();

        await setup();
        kernel.setCompressor(params);
        kernel.resetCompressor();
        stepBlock(24000, 0.5, 0.5);
        const both = kernel.compressorGainDb();

        // L = 0.01 ist 34 dB leiser; wäre der Detektor je Kanal, bliebe L
        // ungeregelt. Verkoppelt müssen beide Fälle identisch sein.
        expect(linked).toBeCloseTo(both, 5);
        expect(both).toBeLessThan(-10);
      });

      it('erholt sich nach dem Release wieder auf 0 dB', async () => {
        await setup();
        kernel.setCompressor(params);
        kernel.resetCompressor();
        stepBlock(24000, STEP);
        expect(kernel.compressorGainDb()).toBeLessThan(-10);
        stepBlock(Math.round(params.release * SR * 8), 0);
        expect(kernel.compressorGainDb()).toBeGreaterThan(-0.05);
      });

      it('bleibt bei ratio 1:1 neutral', async () => {
        await setup();
        kernel.setCompressor({ ...params, ratio: 1, attack: 0.001, release: 0.001 });
        kernel.resetCompressor();
        const { outL } = stepBlock(1000, 0.9);
        expect(outL[outL.length - 1]).toBeCloseTo(0.9, 6);
        expect(kernel.compressorGainDb()).toBe(0);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Ausführung gegen beide Implementierungen
// ---------------------------------------------------------------------------

conformanceSuite('TS-Referenz (Orakel-Ersatz)', async () => new ReferenceDspKernel());

describe.skipIf(!HAS_PROCESSORS)(`DSP-Kern – WASM (${WASM_SKIP_REASON.slice(0, 40)}…)`, () => {
  // Nur ausgeführt, wenn das Modul die Prozessoren wirklich enthält.
  const factory: KernelFactory = async () => DspKernelWasm.fromBytes(wasmBytes);
  conformanceSuite('WASM-Modul', factory);

  it('stimmt Sample für Sample mit der TS-Referenz überein', async () => {
    const wasm = await DspKernelWasm.fromBytes(wasmBytes);
    const ref = new ReferenceDspKernel();

    const n = 4096;
    const inL = new Float32Array(n);
    const inR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      inL[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.8;
      inR[i] = Math.sin((2 * Math.PI * 660 * i) / SR) * 0.6;
    }

    const filter: FilterParams = { kind: 'lowpass', sampleRate: SR, cutoff: 1200, q: 2 };
    wasm.setFilter(filter);
    ref.setFilter(filter);
    const wfL = new Float32Array(n);
    const wfR = new Float32Array(n);
    const rfL = new Float32Array(n);
    const rfR = new Float32Array(n);
    wasm.processFilter(inL, inR, wfL, wfR);
    ref.processFilter(inL, inR, rfL, rfR);
    for (let i = 0; i < n; i++) {
      expect(Math.abs(wfL[i] - rfL[i])).toBeLessThan(1e-4);
      expect(Math.abs(wfR[i] - rfR[i])).toBeLessThan(1e-4);
    }

    wasm.setSaturation({ drive: 3, trim: 0.7 });
    ref.setSaturation({ drive: 3, trim: 0.7 });
    const wsL = new Float32Array(n);
    const wsR = new Float32Array(n);
    const rsL = new Float32Array(n);
    const rsR = new Float32Array(n);
    wasm.processSaturation(inL, inR, wsL, wsR);
    ref.processSaturation(inL, inR, rsL, rsR);
    for (let i = 0; i < n; i++) expect(Math.abs(wsL[i] - rsL[i])).toBeLessThan(1e-4);

    const comp: CompressorParams = {
      sampleRate: SR, threshold: -20, ratio: 4, attack: 0.005, release: 0.1,
    };
    wasm.setCompressor(comp);
    ref.setCompressor(comp);
    const wcL = new Float32Array(n);
    const wcR = new Float32Array(n);
    const rcL = new Float32Array(n);
    const rcR = new Float32Array(n);
    wasm.processCompressor(inL, inR, wcL, wcR);
    ref.processCompressor(inL, inR, rcL, rcR);
    for (let i = 0; i < n; i++) {
      expect(Math.abs(wcL[i] - rcL[i])).toBeLessThan(1e-4);
      expect(Math.abs(wcR[i] - rcR[i])).toBeLessThan(1e-4);
    }
    expect(Math.abs(wasm.compressorGainDb() - ref.compressorGainDb())).toBeLessThan(1e-4);
    wasm.dispose();
  });
});

// ---------------------------------------------------------------------------
// ABI-Status des ausgelieferten Moduls (immer ausgeführt)
// ---------------------------------------------------------------------------

describe('dspKernel.wasm – ABI-Status', () => {
  it('lädt als importfreies Modul mit dem Bestands-Export dsp_process', () => {
    expect(WebAssembly.Module.imports(wasmModule)).toHaveLength(0);
    expect(wasmExportNames).toContain('memory');
    expect(wasmExportNames).toContain('alloc');
    expect(wasmExportNames).toContain('free_ptr');
    expect(wasmExportNames).toContain('dsp_process');
  });

  it('meldet fehlende Prozessoren als Fehler mit Build-Kommando (ABI v1)', async () => {
    const kernel = await DspKernelWasm.fromBytes(wasmBytes);
    expect(kernel.hasProcessors).toBe(HAS_PROCESSORS);
    if (HAS_PROCESSORS) {
      expect(kernel.abiVersion).toBeGreaterThanOrEqual(2);
      expect(() => kernel.setFilter(lp(1000))).not.toThrow();
    } else {
      // Kein stiller Durchreiche-Pfad: der Aufruf muss laut scheitern und das
      // fehlende Target nennen, statt Stille zu liefern.
      expect(() => kernel.setFilter(lp(1000))).toThrow(/wasm32-unknown-unknown/);
      expect(() => kernel.processCompressor(
        new Float32Array(8), new Float32Array(8), new Float32Array(8), new Float32Array(8),
      )).toThrow(/dsp_comp_process/);
    }
    kernel.dispose();
  });

  it('verarbeitet den Bestands-Gain/Mix-Pfad in-place korrekt', async () => {
    const kernel = await DspKernelWasm.fromBytes(wasmBytes);
    const l = Float32Array.from([0.5, -0.25, 0, 2]);
    const r = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    // In-place: out === in muss erlaubt sein.
    kernel.processGain(l, r, l, r, 2);
    expect(Array.from(l)).toEqual([1, -0.5, 0, 4]);
    // f32-Produkte: 0.1*2 ist in f32 0.20000000298…, deshalb closeTo statt toEqual.
    for (let i = 0; i < r.length; i++) expect(r[i]).toBeCloseTo([0.2, 0.4, 0.6, 0.8][i] as number, 6);
    kernel.dispose();
  });

  it('verwaltet die Scratch-Buffer über wechselnde Blockgrößen', async () => {
    const kernel = await DspKernelWasm.fromBytes(wasmBytes);
    // 128 → 4096 (Wachstum, memory.grow + neue Views) → 64 (Wiederverwendung).
    for (const n of [128, 4096, 64]) {
      const l = new Float32Array(n).fill(0.25);
      const r = new Float32Array(n).fill(-0.5);
      const outL = new Float32Array(n);
      const outR = new Float32Array(n);
      kernel.processGain(l, r, outL, outR, 2);
      expect(outL[n - 1]).toBeCloseTo(0.5, 5);
      expect(outR[n - 1]).toBeCloseTo(-1, 5);
    }
    kernel.dispose();
    expect(kernel.isDisposed).toBe(true);
    // Nach dispose() kein stiller Zugriff auf freigegebene Pointer.
    expect(() => kernel.processGain(
      new Float32Array(8), new Float32Array(8), new Float32Array(8), new Float32Array(8), 1,
    )).toThrow(/dispose/);
  });
});
