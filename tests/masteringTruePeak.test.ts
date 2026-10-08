// @vitest-environment node
/**
 * RT-AUDIT-P0-004: Masterkette ohne Verzerrung
 * ============================================
 * Vorher regelte der MasteringNode pro Sample aus dem Momentanpegel (statischer
 * Waveshaper, Limiter ohne Lookahead) und der MasterSumNode wandte immer
 * `tanh(v) * 0.98` an: THD 0,132 % bei −18 dBFS, 17,4 % bei −6 dBFS.
 *
 * Belegt wird:
 *  - THD der Default-Masterkette wie `scripts/audit/rt-bench.ts` (1 kHz):
 *    −18 dBFS < 0,1 %, −6 dBFS < 0,5 %; MasterSumNode ist linear;
 *  - Sinus-Burst +6 dBFS: Ausgang nie > ceiling + 1e-6, die harte Sicherung
 *    greift nicht (Zähler 0); True-Peak-Detektor hält auch Inter-Sample-Peaks;
 *  - Impuls: Ausgabeverzögerung exakt `lookaheadSamples` (= PDC-Wert,
 *    = `getLatencyBudgetMs`);
 *  - Allokationsfreiheit: Ausgangsreferenzen über 1000 Blöcke identisch, keine
 *    neuen Port-Puffer;
 *  - Attack/Release: Pegelsprung −30 → −6 dBFS erreicht 63 % der
 *    Gain-Reduction nach ≈ Attack-Zeit (±30 %), Rücksprung fällt nach
 *    ≈ Release-Zeit auf 37 %;
 *  - Legacy-Worklet `masteringProcessor` rechnet mit demselben Kern.
 */
import { describe, expect, it } from 'vitest';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { MasterSumNode, SourceNode } from '../src/core/audio/nodes/basicNodes';
import { MasteringNode } from '../src/core/audio/nodes/processingNodes';
import { V2MonitorGraph } from '../src/core/audio/V2MonitorGraph';
import { V2_CHANNELS } from '../src/core/audio/V2StudioGraph';
import { getPortBufferAllocations } from '../src/core/audio/PortBuffers';
import { v2MasteringLookaheadSamples } from '../src/core/audio/live/v2Pdc';
import { MASTERING_DEFAULTS, MasteringDynamics } from '../src/core/dsp/masteringDynamics';
import { MasteringProcessor } from '../src/audio/worklets/masteringProcessor';
import { audioEngine } from '../src/utils/audioEngine';
import type { IProcessingContext } from '../src/core/audio/types';

const SR = 48000;
const N = 128;
const ctxAt = (block: number, sr = SR, n = N): IProcessingContext => ({
  sampleRate: sr,
  bufferSize: n,
  quantum: n / sr,
  currentTime: (block * n) / sr,
});

/** THD wie in scripts/audit/rt-bench.ts (Harmonische 2…7 relativ zur Grundwelle). */
function thdOf(sig: Float32Array, f0: number, sr = SR): number {
  const mag = (k: number): number => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < sig.length; i++) {
      const ph = (2 * Math.PI * k * f0 * i) / sr;
      re += sig[i] * Math.cos(ph);
      im -= sig[i] * Math.sin(ph);
    }
    return Math.hypot(re, im);
  };
  const h1 = mag(1);
  let hs = 0;
  for (let k = 2; k <= 7; k++) hs += mag(k) ** 2;
  return Math.sqrt(hs) / h1;
}

/** Default-Masterkette (V2MonitorGraph) wie rt-bench: 1 kHz auf Kanal 1, Fader 0 dB. */
function masterChainThd(dbfs: number): { thd: number; clips: number } {
  const g = new V2MonitorGraph(SR, N);
  const amp = 10 ** (dbfs / 20);
  const out = new Float32Array(9600);
  let w = 0;
  const silence = new Float32Array(N);
  for (let b = 0; b < 400; b++) {
    const buf = new Float32Array(N);
    for (let i = 0; i < N; i++) buf[i] = amp * Math.SQRT2 * Math.sin((2 * Math.PI * 1000 * (b * N + i)) / SR);
    g.setSourceBuffer('channel1', [buf]);
    for (const ch of V2_CHANNELS) if (ch !== 'channel1') g.setSourceBuffer(ch, [silence]);
    const r = g.renderMain(ctxAt(b));
    if (r && b >= 200) for (let i = 0; i < N && w < out.length; i++) out[w++] = r[0][i];
  }
  return { thd: thdOf(out, 1000) * 100, clips: g.masterMastering.safetyClipCount };
}

/** Rendert `input` (Kanäle gleich lang) blockweise durch einen MasteringNode. */
function runMastering(node: MasteringNode, input: Float32Array[], sr = SR, n = N): Float32Array[] {
  const len = input[0].length;
  const graph = new AudioGraph();
  const src = new SourceNode('src', input.map(() => new Float32Array(n)), sr);
  graph.addNode(src);
  graph.addNode(node);
  graph.connect(src.outputs[0], node.inputs[0]);
  graph.compile();
  const out = input.map(() => new Float32Array(len));
  for (let b = 0; b * n < len; b++) {
    const blockIn = input.map((ch) => {
      const blk = new Float32Array(n);
      blk.set(ch.subarray(b * n, Math.min(len, (b + 1) * n)));
      return blk;
    });
    src.sourceBuffer = blockIn;
    graph.process(ctxAt(b, sr, n));
    const o = node.outputs[0].buffer!;
    for (let ch = 0; ch < out.length; ch++) {
      out[ch].set(o[ch].subarray(0, Math.min(n, len - b * n)), b * n);
    }
  }
  return out;
}

function sine(freq: number, len: number, amp: number, phase = 0, sr = SR): Float32Array {
  const a = new Float32Array(len);
  for (let i = 0; i < len; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr + phase);
  return a;
}

/** Bandbegrenzte Rekonstruktion (16×, Hann-gefensterter Sinc) – Referenz-True-Peak. */
function reconstructedPeak(s: Float32Array, from: number, to: number): number {
  let peak = 0;
  for (let n = from; n < to; n++) {
    for (let f = 0; f < 16; f++) {
      const t = n + f / 16;
      let v = 0;
      for (let k = n - 64; k <= n + 64; k++) {
        const x = t - k;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / 65);
        v += s[k] * (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w;
      }
      peak = Math.max(peak, Math.abs(v));
    }
  }
  return peak;
}

describe('RT-AUDIT-P0-004 · Klirrfaktor der Default-Masterkette (wie audit:rt)', () => {
  it('−18 dBFS: THD < 0,1 % (Kette linear unterhalb der Kennlinie)', () => {
    const { thd, clips } = masterChainThd(-18);
    expect(thd).toBeLessThan(0.1);
    expect(clips).toBe(0);
  });

  it('−6 dBFS: THD < 0,5 % (Kompression mit Attack/Release statt Waveshaper)', () => {
    const { thd, clips } = masterChainThd(-6);
    expect(thd).toBeLessThan(0.5);
    expect(clips).toBe(0);
  });

  it('MasterSumNode ist linear (kein tanh): 1,5 bleibt 1,5, NaN/Inf → 0', () => {
    const graph = new AudioGraph();
    const src = new SourceNode('s', [Float32Array.from([1.5, -0.25, Number.NaN, Number.POSITIVE_INFINITY])]);
    const sum = new MasterSumNode('sum', 1);
    graph.addNode(src);
    graph.addNode(sum);
    graph.connect(src.outputs[0], sum.inputs[0]);
    graph.process(ctxAt(0, SR, 4));
    const out = sum.outputs[0].buffer!;
    expect(Array.from(out[0])).toEqual([1.5, -0.25, 0, 0]);
    expect(Array.from(out[1])).toEqual([1.5, -0.25, 0, 0]);
  });
});

describe('RT-AUDIT-P0-004 · Lookahead-Limiter hält das Ceiling', () => {
  it('Sinus-Burst +6 dBFS: Ausgang nie > ceiling + 1e-6, Sicherung greift nicht', () => {
    for (const freq of [100, 1000, 5000, 11000]) {
      for (const ceiling of [0.98, 0.5]) {
        const node = new MasteringNode('mst');
        node.ceiling.setValue(ceiling);
        const len = SR / 2;
        const amp = 10 ** (6 / 20); // +6 dBFS Peak
        const l = new Float32Array(len);
        const r = new Float32Array(len);
        // Burst: 50 ms Stille, 300 ms +6 dBFS, Rest Stille (harter Einsatz).
        for (let i = 2400; i < 2400 + 14400; i++) {
          l[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
          r[i] = amp * Math.cos((2 * Math.PI * freq * i) / SR);
        }
        const out = runMastering(node, [l, r]);
        let peak = 0;
        for (const ch of out) for (const v of ch) peak = Math.max(peak, Math.abs(v));
        expect(peak, `${freq} Hz, ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling + 1e-6);
        expect(peak, 'nicht weggeregelt').toBeGreaterThan(ceiling * 0.5);
        expect(node.safetyClipCount, 'harte Sicherung darf nicht greifen').toBe(0);
      }
    }
  });

  it('Limiter = Brute-Force-Referenzmodell (Fenster-Minimum per Scan), auch bei voller Deque', () => {
    // Abklingende Hüllkurven über dem Ceiling → streng steigende Ziel-Gains über
    // das ganze Fenster (Deque voll), dazwischen neue Spitzen und Pausen.
    const len = SR / 2;
    const l = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const seg = i % 6000;
      l[i] = (i % 2 === 0 ? 1 : -1) * 4 * Math.exp(-seg / 1500) * (seg < 4500 ? 1 : 0.1);
    }
    const r = l.map((v) => v * 0.5);
    const ceiling = 0.5;
    const d = new MasteringDynamics(SR, 2, { truePeak: false });
    d.ratio = 1; // Kompressor neutral, nur der Limiter
    d.ceiling = ceiling;
    const outL = l.slice();
    const outR = r.slice();
    d.process([outL, outR], 0, len);

    // Referenz: dieselbe Kette, aber das Fenster-Minimum per O(W)-Scan.
    const L = d.lookaheadSamples;
    const W = L + 1;
    const B = L + 1;
    const lr = d.limiterReleaseCoef;
    const target = new Float64Array(len);
    for (let n = 0; n < len; n++) {
      const det = Math.max(Math.abs(l[n]), Math.abs(r[n]));
      target[n] = det > ceiling ? ceiling / det : 1;
    }
    const box = new Float64Array(B).fill(1);
    let boxSum = B;
    let below = 0;
    let env = 1;
    for (let n = 0; n < len; n++) {
      let wm = 1;
      for (let k = Math.max(0, n - W + 1); k <= n; k++) wm = Math.min(wm, target[k]);
      if (wm <= env) env = wm;
      else {
        env += lr * (wm - env);
        if (wm - env < 1e-12) env = wm;
      }
      const old = box[n % B];
      box[n % B] = env;
      boxSum += env - old;
      if (old < 1) below--;
      if (env < 1) below++;
      let gain = 1;
      if (below === 0) boxSum = B;
      else gain = Math.min(1, boxSum / B);
      for (const [src, out] of [[l, outL], [r, outR]] as const) {
        const v = n >= L ? src[n - L] * gain : 0;
        const ref = Math.max(-ceiling, Math.min(ceiling, v));
        expect(out[n], `Sample ${n}`).toBe(Math.fround(ref));
      }
    }
    expect(d.safetyClipCount).toBe(0);
  });

  it('True-Peak (4×-FIR, BS.1770-4): Inter-Sample-Peaks bleiben unter dem Ceiling', () => {
    // 12 kHz mit 45° Phase: Samples nur ±0,707·A, der echte Peak ist A.
    const len = 8000;
    const input = sine(12000, len, 1, Math.PI / 4);
    const withTp = new MasteringDynamics(SR, 1, { truePeak: true });
    const samplePeakOnly = new MasteringDynamics(SR, 1, { truePeak: false });
    for (const d of [withTp, samplePeakOnly]) {
      d.ratio = 1; // nur der Limiter
      d.ceiling = 0.5;
    }
    const a = [input.slice()];
    const b = [input.slice()];
    withTp.process(a, 0, len);
    samplePeakOnly.process(b, 0, len);
    const tpWith = reconstructedPeak(a[0], 2000, 2600);
    const tpWithout = reconstructedPeak(b[0], 2000, 2600);
    // Mit True-Peak-Detektor bleibt auch der rekonstruierte Peak ≤ Ceiling
    // (± 0,1 dB Interpolationstoleranz); ohne überschreitet er es um ~3 dB.
    expect(tpWith).toBeLessThanOrEqual(0.5 * 1.0116);
    expect(tpWithout).toBeGreaterThan(0.5 * 1.3);
    expect(withTp.safetyClipCount).toBe(0);
  });
});

describe('RT-AUDIT-P0-004 · Latenz = lookaheadSamples (PDC, Latenzanzeige)', () => {
  it('Impuls kommt nach exakt lookaheadSamples heraus (44,1/48/96 kHz), sonst nichts', () => {
    for (const sr of [44100, 48000, 96000]) {
      const node = new MasteringNode('mst', sr);
      const L = node.lookaheadSamples;
      expect(L).toBe(Math.round(0.005 * sr));
      expect(L).toBe(v2MasteringLookaheadSamples(sr));
      const len = L + 4 * N;
      const x = new Float32Array(len);
      x[0] = 0.1; // −20 dBFS: unterhalb der Kennlinie, Kette transparent
      const out = runMastering(node, [x, x.slice()], sr)[0];
      const hits: number[] = [];
      for (let i = 0; i < len; i++) if (out[i] !== 0) hits.push(i);
      expect(hits).toEqual([L]);
      expect(out[L]).toBe(Math.fround(0.1));
    }
  });

  it('getLatencyBudgetMs weist den echten Lookahead des MasteringNode aus', () => {
    const node = new MasteringNode('mst', 48000);
    const budget = audioEngine.getLatencyBudgetMs();
    expect(budget.masteringLookaheadMs).toBeCloseTo((node.lookaheadSamples / 48000) * 1000, 9);
    expect(budget.masteringLookaheadMs).toBeCloseTo(node.latencySeconds * 1000, 9);
    // Der V2-Cue-Weg ist um denselben Betrag kompensiert.
    expect(budget.cuePdcMs).toBe(budget.masteringLookaheadMs);
  });

  it('V2MonitorGraph: Cue-Weg zum Monitor ist um den Lookahead kompensiert (phasengleich zu MAIN)', () => {
    const g = new V2MonitorGraph(SR, N);
    expect(g.mainLatencySamples).toBe(v2MasteringLookaheadSamples(SR));
    expect(g.cuePdc.getDelayFrames()).toBe(g.mainLatencySamples);
  });
});

describe('RT-AUDIT-P0-004 · Allokationsfreiheit', () => {
  it('Ausgangsreferenzen bleiben über 1000 Blöcke identisch, keine neuen Port-Puffer', () => {
    const graph = new AudioGraph();
    const src = new SourceNode('src', [sine(997, N, 1.6), sine(1499, N, 1.2)]);
    const node = new MasteringNode('mst');
    graph.addNode(src);
    graph.addNode(node);
    graph.connect(src.outputs[0], node.inputs[0]);
    graph.compile();
    let set: Float32Array[] | null = null;
    let ch0: Float32Array | null = null;
    let ch1: Float32Array | null = null;
    let allocAfterWarmup = 0;
    for (let b = 0; b < 1000; b++) {
      graph.process(ctxAt(b));
      if (b === 10) {
        set = node.outputs[0].buffer;
        ch0 = set![0];
        ch1 = set![1];
        allocAfterWarmup = getPortBufferAllocations();
      }
    }
    expect(node.outputs[0].buffer).toBe(set);
    expect(node.outputs[0].buffer![0]).toBe(ch0);
    expect(node.outputs[0].buffer![1]).toBe(ch1);
    expect(getPortBufferAllocations()).toBe(allocAfterWarmup);
    expect(node.safetyClipCount).toBe(0);
  });
});

describe('RT-AUDIT-P0-004 · Attack/Release des Kompressors (smooth decoupled peak detector)', () => {
  /**
   * Verarbeitet `input` (in place) Sample für Sample. Ab `start` wird die Zeit
   * (s) gemessen, bis die Gain-Reduction `fraction` des Weges vom Wert bei
   * `start` nach `to` zurückgelegt hat.
   */
  function timeTo(d: MasteringDynamics, input: Float32Array, start: number, to: number, fraction: number): number {
    const buf = [input];
    for (let i = 0; i < start; i++) d.process(buf, i, i + 1);
    const from = d.gainReductionDb;
    const goal = from + (to - from) * fraction;
    for (let i = start; i < input.length; i++) {
      d.process(buf, i, i + 1);
      const gr = d.gainReductionDb;
      if (to > from ? gr >= goal : gr <= goal) return (i - start + 1) / SR;
    }
    return Number.POSITIVE_INFINITY;
  }

  /** −30 dBFS bis `jump`, danach −6 dBFS (1 kHz-Sinus). */
  function stepSignal(jump: number, len: number): Float32Array {
    const x = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const amp = 10 ** ((i < jump ? -30 : -6) / 20);
      x[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / SR);
    }
    return x;
  }

  /** Eingeschwungene Gain-Reduction bei −6 dBFS (Default-Kennlinie). */
  function steadyGr(attack: number, release: number): number {
    const d = new MasteringDynamics(SR, 1);
    d.setTimes(attack, release, MASTERING_DEFAULTS.release);
    const x = stepSignal(0, SR * 2);
    d.process([x], 0, x.length);
    return d.gainReductionDb;
  }

  it('Defaults dokumentiert: Attack 10 ms, Release 100 ms (automatisierbare Parameter)', () => {
    const node = new MasteringNode('mst');
    expect(node.getParameter('compAttack')?.value).toBe(0.01);
    expect(node.getParameter('compRelease')?.value).toBe(0.1);
    expect(node.getParameter('release')?.value).toBe(0.05); // Limiter-Release
    expect(MASTERING_DEFAULTS.compAttack).toBe(0.01);
    expect(MASTERING_DEFAULTS.compRelease).toBe(0.1);
  });

  it('−30 → −6 dBFS: 63 % der Gain-Reduction nach ≈ Attack-Zeit (±30 %)', () => {
    for (const attack of [0.005, 0.01, 0.03]) {
      const target = steadyGr(attack, 0.1);
      // −6 dBFS Peak, Threshold −14, Ratio 3 → statisch 5,33 dB.
      expect(target).toBeGreaterThan(5);
      expect(target).toBeLessThan(5.4);
      const d = new MasteringDynamics(SR, 1);
      d.setTimes(attack, 0.1, MASTERING_DEFAULTS.release);
      const jump = SR / 10;
      const t63 = timeTo(d, stepSignal(jump, jump + SR / 2), jump, target, 1 - Math.exp(-1));
      expect(t63, `Attack ${attack * 1000} ms`).toBeGreaterThan(attack * 0.7);
      expect(t63, `Attack ${attack * 1000} ms`).toBeLessThan(attack * 1.3);
    }
  });

  it('−6 → −30 dBFS: Gain-Reduction fällt nach ≈ Release-Zeit auf 37 % (±30 %)', () => {
    for (const release of [0.05, 0.1, 0.3]) {
      const d = new MasteringDynamics(SR, 1);
      d.setTimes(0.01, release, MASTERING_DEFAULTS.release);
      const len = SR * 3;
      const back = SR * 2;
      const x = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const amp = 10 ** ((i < back ? -6 : -30) / 20);
        x[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / SR);
      }
      const t37 = timeTo(d, x, back, 0, 1 - Math.exp(-1));
      expect(t37, `Release ${release * 1000} ms`).toBeGreaterThan(release * 0.7);
      expect(t37, `Release ${release * 1000} ms`).toBeLessThan(release * 1.3);
    }
  });
});

describe('RT-AUDIT-P0-004 · Legacy-Worklet nutzt denselben Kern', () => {
  it('masteringProcessor und MasteringNode liefern dasselbe Signal (Kompression + Limiter)', () => {
    const len = 48 * N;
    const l = new Float32Array(len);
    for (let i = 0; i < len; i++) l[i] = (i < len / 2 ? 0.3 : 1.6) * Math.sin((2 * Math.PI * 440 * i) / SR);
    const node = new MasteringNode('mst');
    const v2 = runMastering(node, [l, l.slice()])[0];

    const proc = new MasteringProcessor();
    expect(proc.getLookaheadSamples()).toBe(node.lookaheadSamples);
    const v1 = new Float32Array(len);
    for (let b = 0; b < len / N; b++) {
      const inBlk = [l.slice(b * N, (b + 1) * N), l.slice(b * N, (b + 1) * N)];
      const outBlk = [new Float32Array(N), new Float32Array(N)];
      proc.process([inBlk], [outBlk]);
      v1.set(outBlk[0], b * N);
    }
    let maxDiff = 0;
    for (let i = 0; i < len; i++) maxDiff = Math.max(maxDiff, Math.abs(v1[i] - v2[i]));
    // Einziger Unterschied: Limiter-Release-Koeffizient aus der LUT (< 0,1 %).
    expect(maxDiff).toBeLessThan(1e-4);
  });
});
