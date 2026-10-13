// @vitest-environment node
/**
 * DSP-P1-OVS-001 · Oversampling der nichtlinearen Saettiger
 * =========================================================
 * Belegt die Akzeptanzpunkte des Tickets:
 *  - Halbband-FIR-Entwurf (Durchlass/Sperrbereich, Halbband-Struktur,
 *    minimalphasige Variante mit gleichem Betragsgang);
 *  - Aliasing-Messung: Sinus nahe 0,4·Fs durch den tanh-Saettiger,
 *    vorher (1x) / nachher (2x, 4x), Alias-Energie unter Schwelle;
 *  - Latenz: gemessene Verzoegerung = gemeldete Latenz, PDC (Cue-Weg,
 *    mainLatencySamples, Offline-Bounce-Summe) zieht nach; Mastering-Lookahead
 *    unveraendert;
 *  - OFF (Faktor 1) bit-identisch zur bisherigen 1x-Formel;
 *  - Allokationsfreiheit im Render-Pfad.
 */
import { describe, expect, it } from 'vitest';
import {
  Oversampler,
  STAGE1_TAPS,
  TanhDriveShaper,
  designHalfbandFir,
  groupDelaySamples,
  magnitudeDb,
  normalizeOversamplingFactor,
  oversamplingLatencySamples,
  oversamplingStageTaps,
  shapeBufferOversampled,
  toMinimumPhase,
  type OversamplingFactor,
  type OversamplingPhase,
} from '../src/core/dsp/oversampling';
import { ALIAS_TEST_N, aliasTestFrequency, aliasTestSample, aliasToSignalDb } from '../src/core/dsp/aliasingMeasure';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { SourceNode } from '../src/core/audio/nodes/basicNodes';
import { DspFilterNode } from '../src/core/audio/nodes/processingNodes';
import { V2MonitorGraph } from '../src/core/audio/V2MonitorGraph';
import { MasteringDynamics, masteringLookaheadSamples } from '../src/core/dsp/masteringDynamics';
import { renderKick } from '../src/core/instrument/drumSynth';
import { getPortBufferAllocations } from '../src/core/audio/PortBuffers';
import { V2_CHANNELS } from '../src/core/audio/V2StudioGraph';
import { DspPluginAdapter } from '../src/plugins/adapters/DspPluginAdapter';
import type { IProcessingContext } from '../src/core/audio/types';

const SR = 48000;
const N = 128;
const ctx = (block: number): IProcessingContext => ({ sampleRate: SR, bufferSize: N, quantum: N / SR, currentTime: (block * N) / SR });

function maxOver(h: Float64Array, from: number, to: number, steps = 400): number {
  let m = -Infinity;
  for (let i = 0; i <= steps; i++) m = Math.max(m, magnitudeDb(h, from + ((to - from) * i) / steps));
  return m;
}

/** DspFilterNode (V2, hoerbarer Pfad) mit Testsinus nahe 0,4·Fs → Alias/Signal in dB. */
function dspNodeAliasDb(factor: number, drive: number, amp: number): number {
  const g = new AudioGraph();
  const src = new SourceNode('s', [new Float32Array(N)]);
  const d = new DspFilterNode('d');
  d.cutoff.setValue(20000);
  d.depth.setValue(0);
  d.drive.setValue(drive);
  d.setOversampling(factor);
  g.addNode(src); g.addNode(d); g.connect(src.outputs[0], d.inputs[0]); g.compile();
  const warm = 32;
  const out = new Float64Array(ALIAS_TEST_N);
  const buf = new Float32Array(N);
  for (let b = 0; b < warm + ALIAS_TEST_N / N; b++) {
    for (let i = 0; i < N; i++) buf[i] = aliasTestSample(b * N + i, amp);
    src.sourceBuffer = [buf];
    g.process(ctx(b));
    if (b >= warm) out.set(d.outputs[0].buffer![0], (b - warm) * N);
  }
  return aliasToSignalDb(out);
}

/** Verzoegerung per Kreuzkorrelation (ganzzahlig) eines Oversamplers im linearen Bereich. */
function measuredDelay(factor: OversamplingFactor, phase: OversamplingPhase): number {
  const os = new Oversampler(factor, phase, 1);
  const lin = { shape: (x: number) => x }; // lineare Kennlinie: nur die Filter
  const len = 4096;
  const x = new Float64Array(len);
  // Bandbegrenztes Rauschen-Ersatz: Summe tiefer Sinusse (unter 2 kHz).
  for (let i = 0; i < len; i++) x[i] = 0.3 * Math.sin(i * 0.031) + 0.2 * Math.sin(i * 0.117 + 1) + 0.1 * Math.sin(i * 0.23 + 2);
  const y = new Float64Array(len);
  for (let i = 0; i < len; i++) y[i] = os.process(0, x[i], lin);
  let best = 0; let bestCorr = -Infinity;
  for (let d = 0; d < 64; d++) {
    let c = 0;
    for (let i = 1024; i < len - 64; i++) c += x[i] * y[i + d];
    if (c > bestCorr) { bestCorr = c; best = d; }
  }
  return best;
}

/** FNV-1a ueber die Float32-Bitmuster (bit-genauer Vergleich). */
function fnv(arrs: Float32Array[]): string {
  let h = 0x811c9dc5;
  for (const a of arrs) {
    const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h.toString(16);
}

function dspNodeHash(factor: number): string {
  const graph = new AudioGraph();
  const src = new SourceNode('s', [new Float32Array(N), new Float32Array(N)]);
  const d = new DspFilterNode('d');
  d.cutoff.setValue(8000); d.resonance.setValue(0.6); d.depth.setValue(0.5); d.drive.setValue(0.7);
  d.setOversampling(factor);
  graph.addNode(src); graph.addNode(d); graph.connect(src.outputs[0], d.inputs[0]); graph.compile();
  const outs: Float32Array[] = [];
  for (let b = 0; b < 40; b++) {
    const L = new Float32Array(N); const R = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = b * N + i;
      L[i] = 0.6 * Math.sin((2 * Math.PI * 3000 * t) / SR);
      R[i] = 0.4 * Math.sin((2 * Math.PI * 5000 * t) / SR) + 0.3 * Math.sin(t * 0.01);
    }
    src.sourceBuffer = [L, R];
    graph.process(ctx(b));
    outs.push(...d.outputs[0].buffer!.map((c) => Float32Array.from(c)));
  }
  return fnv(outs);
}

function adapterHash(factor: number | null): string {
  const a = new DspPluginAdapter();
  const parameters: Record<string, number> = { drive: 0.6, cutoff: 6000, resonance: 0.3 };
  if (factor !== null) parameters.oversampling = factor;
  a.restore({ pluginId: 'dsp', state: 'PRO', parameters } as never);
  const outs: Float32Array[] = [];
  for (let b = 0; b < 4; b++) {
    const ch = [0, 1].map((c) => Float32Array.from({ length: 512 }, (_, i) => 0.8 * Math.sin((b * 512 + i) * (0.2 + c * 0.05))));
    const r = a.process({ channels: ch, sampleRate: SR, timestamp: 0, frameCount: 512 });
    outs.push(...(r.channels as Float32Array[]).map((c) => Float32Array.from(c)));
  }
  return fnv(outs);
}

async function workletHash(factor: number | null): Promise<string> {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = SR;
  g.AudioWorkletProcessor ??= class { port = { onmessage: null as null, postMessage: () => {} }; };
  g.registerProcessor ??= () => {};
  const { DspProcessor } = await import('../src/audio/worklets/dspProcessor');
  const p = new DspProcessor() as unknown as {
    port: { onmessage: (e: { data: unknown }) => void };
    process(i: Float32Array[][], o: Float32Array[][]): boolean;
  };
  p.port.onmessage({ data: { drive: 0.7, filterCutoff: 6000, resonance: 0.6, depth: 0.4, phase: 0.7 } });
  if (factor !== null) p.port.onmessage({ data: { oversampling: factor } });
  const outs: Float32Array[] = [];
  for (let b = 0; b < 20; b++) {
    const inp = [0, 1].map((c) => Float32Array.from({ length: N }, (_, i) => 0.7 * Math.sin((b * N + i) * (0.3 + c * 0.1))));
    const out = [new Float32Array(N), new Float32Array(N)];
    p.process([inp], [out]);
    outs.push(...out);
  }
  return fnv(outs);
}

describe('DSP-P1-OVS-001 · Halbband-FIR-Entwurf', () => {
  it('Halbband-Struktur: Mitte 0,5, jeder zweite Tap 0, DC-Gain 1', () => {
    const h = designHalfbandFir(STAGE1_TAPS, 7);
    const c = (STAGE1_TAPS - 1) / 2;
    expect(h[c]).toBe(0.5);
    for (let i = 0; i < h.length; i++) if (i !== c && (i - c) % 2 === 0) expect(h[i]).toBe(0);
    expect(h.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
    // Symmetrisch (linearphasig).
    for (let i = 0; i < h.length; i++) expect(h[i]).toBeCloseTo(h[h.length - 1 - i], 14);
    expect(() => designHalfbandFir(20, 6)).toThrow();
  });

  it('Stufe 1: Durchlass bis 0,4·Fs < 0,01 dB, Sperrbereich ab 0,6·Fs >= 70 dB (beide Phasen)', () => {
    for (const phase of ['linear', 'minimum'] as const) {
      const h = oversamplingStageTaps(phase, 1);
      // Normiert auf die 2x-Rate: 0,4·Fs = 0,2, 0,6·Fs = 0,3.
      let ripple = 0;
      for (let i = 0; i <= 100; i++) ripple = Math.max(ripple, Math.abs(magnitudeDb(h, (0.2 * i) / 100)));
      expect(ripple).toBeLessThan(0.01);
      expect(maxOver(h, 0.3, 0.5)).toBeLessThan(-70);
    }
  });

  it('Stufe 2 (4x): Durchlass bis 0,4·Fs, Sperrbereich ab 1,4·Fs >= 50 dB', () => {
    for (const phase of ['linear', 'minimum'] as const) {
      const h = oversamplingStageTaps(phase, 2);
      let ripple = 0;
      for (let i = 0; i <= 100; i++) ripple = Math.max(ripple, Math.abs(magnitudeDb(h, (0.1 * i) / 100)));
      expect(ripple).toBeLessThan(0.01);
      expect(maxOver(h, 0.35, 0.5)).toBeLessThan(-50);
    }
  });

  it('minimalphasig: gleicher Betragsgang, Gruppenlaufzeit << linearphasig', () => {
    const lin = designHalfbandFir(STAGE1_TAPS, 7);
    const min = toMinimumPhase(lin);
    for (let i = 0; i <= 40; i++) {
      const f = (0.2 * i) / 40;
      expect(Math.abs(magnitudeDb(min, f) - magnitudeDb(lin, f))).toBeLessThan(0.01);
    }
    expect(groupDelaySamples(lin, 0)).toBeCloseTo(23, 9);
    expect(groupDelaySamples(min, 0)).toBeLessThan(4);
  });
});

describe('DSP-P1-OVS-001 · Aliasing-Messung (Sinus nahe 0,4·Fs)', () => {
  it('Testsinus liegt nahe 0,4·Fs', () => {
    expect(aliasTestFrequency(SR) / SR).toBeGreaterThan(0.39);
    expect(aliasTestFrequency(SR) / SR).toBeLessThan(0.4);
  });

  it('Oversampler: 2x und 4x senken die Alias-Energie deutlich gegenueber 1x (vorher/nachher)', () => {
    const run = (factor: OversamplingFactor, phase: OversamplingPhase): number => {
      const os = new Oversampler(factor, phase, 1);
      const sh = new TanhDriveShaper();
      // Drive 0,5 (Vorverstaerkung 2) – die Kennlinie des DSP-Saettigers.
      sh.pre = 2;
      sh.norm = Math.tanh(1.8);
      const out = new Float64Array(ALIAS_TEST_N);
      for (let i = 0; i < 4096 + ALIAS_TEST_N; i++) {
        const y = os.process(0, aliasTestSample(i, 0.5), sh);
        if (i >= 4096) out[i - 4096] = y;
      }
      return aliasToSignalDb(out);
    };
    for (const phase of ['minimum', 'linear'] as const) {
      const before = run(1, phase);
      const x2 = run(2, phase);
      const x4 = run(4, phase);
      expect(before).toBeGreaterThan(-30); // 1x: deutlich hoerbares Aliasing
      expect(x2).toBeLessThan(before - 15);
      expect(x2).toBeLessThan(-40);
      expect(x4).toBeLessThan(-70);
    }
  });

  it('DspFilterNode (hoerbarer V2-Pfad): Default 2x, Alias-Energie unter Schwelle', () => {
    const before = dspNodeAliasDb(1, 1, 0.5);
    const after2 = dspNodeAliasDb(2, 1, 0.5);
    const after4 = dspNodeAliasDb(4, 1, 0.5);
    expect(new DspFilterNode('x').oversamplingFactor).toBe(2);
    expect(before).toBeGreaterThan(-30);
    expect(after2).toBeLessThan(-40);
    expect(after2).toBeLessThan(before - 15);
    expect(after4).toBeLessThan(-70);
  });
});

describe('DSP-P1-OVS-001 · Latenz und PDC', () => {
  it('gemeldete Latenz = gemessene Verzoegerung (linear exakt, minimalphasig gerundet)', () => {
    expect(oversamplingLatencySamples(1, 'minimum')).toBe(0);
    expect(oversamplingLatencySamples(2, 'linear')).toBe(23);
    expect(oversamplingLatencySamples(4, 'linear')).toBe(28);
    expect(oversamplingLatencySamples(2, 'minimum')).toBe(3);
    expect(oversamplingLatencySamples(4, 'minimum')).toBe(4);
    for (const phase of ['linear', 'minimum'] as const) {
      for (const f of [2, 4] as const) {
        expect(measuredDelay(f, phase)).toBe(oversamplingLatencySamples(f, phase));
      }
    }
  });

  it('linearphasig: Ausgang = um die Latenz verschobener Eingang (bandbegrenzt)', () => {
    for (const f of [2, 4] as const) {
      const os = new Oversampler(f, 'linear', 1);
      const L = os.latencySamples;
      const lin = { shape: (x: number) => x };
      const x = Array.from({ length: 2048 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR));
      const y = x.map((v) => os.process(0, v, lin));
      let err = 0;
      for (let i = 512; i < 2048; i++) err = Math.max(err, Math.abs(y[i] - x[i - L]));
      expect(err).toBeLessThan(1e-3);
    }
  });

  it('DspFilterNode meldet Latenz nur mit Drive > 0 und Oversampling an', () => {
    const d = new DspFilterNode('d');
    expect(d.latencySamples).toBe(0);
    d.drive.setValue(0.5);
    expect(d.latencySamples).toBe(3);
    d.setOversampling(4);
    expect(d.latencySamples).toBe(4);
    d.setOversampling(1);
    expect(d.latencySamples).toBe(0);
  });

  it('V2MonitorGraph: mainLatencySamples und Cue-PDC ziehen die Saettiger-Latenz nach, Lookahead unveraendert', () => {
    const g = new V2MonitorGraph(SR, N);
    const silence = new Float32Array(N);
    for (const ch of V2_CHANNELS) g.setSourceBuffer(ch, [silence]);
    const look = masteringLookaheadSamples(SR);
    g.render(ctx(0));
    expect(g.mainLatencySamples).toBe(look);
    expect(g.cuePdc.getDelayFrames()).toBe(look);
    expect(g.masterMastering.lookaheadSamples).toBe(look);

    const allocBefore = getPortBufferAllocations();
    g.setMasterDsp(20000, 0.5, 0, 0.6);
    g.render(ctx(1));
    expect(g.mainLatencySamples).toBe(look + 3);
    expect(g.cuePdc.getDelayFrames()).toBe(look + 3);
    expect(g.masterMastering.lookaheadSamples).toBe(look); // Mastering-Lookahead nicht verschlechtert

    g.setMasterDspOversampling(4);
    g.render(ctx(2));
    expect(g.cuePdc.getDelayFrames()).toBe(look + 4);
    g.setMasterDspOversampling(1);
    g.render(ctx(3));
    expect(g.cuePdc.getDelayFrames()).toBe(look);
    // Umschalten innerhalb der reservierten PDC-Kapazitaet: keine neuen Port-Puffer.
    expect(getPortBufferAllocations()).toBe(allocBefore);
  });

  it('Main-Weg ist gegenueber dem Cue-Weg phasengleich verzoegert (Impuls)', () => {
    const g = new V2MonitorGraph(SR, N);
    g.setMasterDsp(20000, 0.5, 0, 0.2);
    g.setMasterMastering?.(0, 1, 1, 1);
    const silence = new Float32Array(N);
    const impulse = new Float32Array(N);
    impulse[0] = 0.1;
    let mainPeak = -1; let mainPeakVal = 0;
    for (let b = 0; b < 12; b++) {
      for (const ch of V2_CHANNELS) g.setSourceBuffer(ch, [ch === 'channel1' && b === 0 ? impulse : silence]);
      const r = g.render(ctx(b));
      const m = r.main?.[0];
      if (m) for (let i = 0; i < N; i++) if (Math.abs(m[i]) > mainPeakVal) { mainPeakVal = Math.abs(m[i]); mainPeak = b * N + i; }
    }
    // Maximum der Impulsantwort liegt im Bereich der gemeldeten Latenz (minimalphasig: Spitze frueh).
    expect(mainPeak).toBeGreaterThanOrEqual(g.masterMastering.lookaheadSamples);
    expect(mainPeak).toBeLessThanOrEqual(g.mainLatencySamples + 3);
  });
});

describe('DSP-P1-OVS-001 · OFF bit-identisch, Allokationsfreiheit', () => {
  // Goldene Hashes: berechnet am 2026-10-13 mit den Vorgaenger-Implementierungen
  // (git HEAD 4c4672e: processingNodes.ts, DspPluginAdapter.ts, dspProcessor.ts)
  // fuer exakt die Szenarien unten. Faktor 1 muss sie bit-genau treffen.
  const GOLDEN_BEFORE = { node: '8475daba', adapter: '273c4617', worklet: 'c8c72b61' };

  it('Faktor 1: DspFilterNode bit-identisch zur Vorgaenger-Implementierung', () => {
    expect(dspNodeHash(1)).toBe(GOLDEN_BEFORE.node);
    expect(dspNodeHash(2)).not.toBe(GOLDEN_BEFORE.node); // Default rechnet oversampled
  });

  it('Faktor 1: DspPluginAdapter bit-identisch zur Vorgaenger-Implementierung', () => {
    expect(adapterHash(1)).toBe(GOLDEN_BEFORE.adapter);
    expect(adapterHash(null)).not.toBe(GOLDEN_BEFORE.adapter);
  });

  it('Faktor 1: dspProcessor-Worklet bit-identisch zur Vorgaenger-Implementierung', async () => {
    expect(await workletHash(1)).toBe(GOLDEN_BEFORE.worklet);
    expect(await workletHash(null)).not.toBe(GOLDEN_BEFORE.worklet);
  });

  it('Faktor 1: Oversampler reicht exakt an die Kennlinie durch', () => {
    const os = new Oversampler(1, 'minimum', 1);
    const sh = new TanhDriveShaper();
    sh.pre = 2.2; sh.norm = 0.9;
    for (let i = 0; i < 100; i++) {
      const x = Math.sin(i * 0.37);
      expect(os.process(0, x, sh)).toBe(Math.tanh(x * 2.2) / 0.9);
    }
  });

  it('Oversampler: Zustandspuffer bleiben fest, Heap waechst im Dauerbetrieb nicht', () => {
    const os = new Oversampler(4, 'minimum', 2);
    const sh = new TanhDriveShaper();
    sh.pre = 3; sh.norm = 1;
    const stages = (os as unknown as { stage1: unknown[]; stage2: unknown[] });
    const refs = [...stages.stage1, ...stages.stage2].map((s) => (s as { xh: Float64Array; uh: Float64Array }));
    const before = refs.map((s) => [s.xh, s.uh]);
    let acc = 0;
    // Warmup (JIT-Optimierung legt einmalig Code/Feedback an), dann messen.
    for (let i = 0; i < 1_000_000; i++) acc += os.process(i & 1, Math.sin(i * 0.01), sh);
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const heap0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 2_000_000; i++) acc += os.process(i & 1, Math.sin(i * 0.01), sh);
    gc?.();
    const grown = process.memoryUsage().heapUsed - heap0;
    expect(Number.isFinite(acc)).toBe(true);
    refs.forEach((s, k) => { expect(s.xh).toBe(before[k][0]); expect(s.uh).toBe(before[k][1]); });
    // 2 Mio. Aufrufe mit einer Allokation je Aufruf waeren >= 32 MB (HeapNumber
    // 16 B). Gemessen mit --expose-gc nach Warmup: ~30 KB je 5 Mio. Aufrufe
    // (Rauschen). Ohne gc() streut heapUsed, daher die grosszuegige Grenze.
    expect(grown).toBeLessThan(8 * 1024 * 1024);
  });

  it('DspFilterNode mit 2x/4x: keine neuen Port-Puffer, Ausgangsreferenz fest', () => {
    for (const f of [2, 4]) {
      const g = new AudioGraph();
      const src = new SourceNode('s', [new Float32Array(N), new Float32Array(N)]);
      const d = new DspFilterNode('d');
      d.drive.setValue(0.8); d.depth.setValue(0.3); d.setOversampling(f);
      g.addNode(src); g.addNode(d); g.connect(src.outputs[0], d.inputs[0]); g.compile();
      let ref: Float32Array[] | null = null;
      let alloc = 0;
      for (let b = 0; b < 500; b++) {
        g.process(ctx(b));
        if (b === 5) { ref = d.outputs[0].buffer; alloc = getPortBufferAllocations(); }
      }
      expect(d.outputs[0].buffer).toBe(ref);
      expect(getPortBufferAllocations()).toBe(alloc);
    }
  });

  it('NaN am Eingang vergiftet den Filterzustand nicht', () => {
    const os = new Oversampler(2, 'minimum', 1);
    const sh = new TanhDriveShaper();
    expect(Number.isFinite(os.process(0, Number.NaN, sh))).toBe(true);
    for (let i = 0; i < 100; i++) expect(Number.isFinite(os.process(0, 0.3, sh))).toBe(true);
  });

  it('normalizeOversamplingFactor', () => {
    expect(normalizeOversamplingFactor(1)).toBe(1);
    expect(normalizeOversamplingFactor(2)).toBe(2);
    expect(normalizeOversamplingFactor(4)).toBe(4);
    expect(normalizeOversamplingFactor(8)).toBe(4);
    expect(normalizeOversamplingFactor(0)).toBe(1);
    expect(normalizeOversamplingFactor('x')).toBe(2);
  });
});

describe('DSP-P1-OVS-001 · Offline-Saettiger und Mastering', () => {
  it('shapeBufferOversampled: weniger Aliasing, zeitgleich zum Eingang (Latenz herausgerechnet)', () => {
    const shaper = new TanhDriveShaper();
    shaper.pre = 2;
    shaper.norm = Math.tanh(1.8);
    const make = (): Float32Array => Float32Array.from({ length: ALIAS_TEST_N + 4096 }, (_, i) => aliasTestSample(i, 0.5));
    const before = aliasToSignalDb(shapeBufferOversampled(make(), shaper, 1).subarray(2048, 2048 + ALIAS_TEST_N));
    const after = aliasToSignalDb(shapeBufferOversampled(make(), shaper, 2).subarray(2048, 2048 + ALIAS_TEST_N));
    expect(after).toBeLessThan(before - 15);
    // Zeitgleich: lineare Kennlinie, tiefer Sinus → Ausgang = Eingang.
    const lin = { shape: (x: number) => x };
    const x = Float32Array.from({ length: 4096 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 500 * i) / SR));
    const y = shapeBufferOversampled(Float32Array.from(x), lin, 2);
    let err = 0;
    for (let i = 256; i < 3800; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
    expect(err).toBeLessThan(1e-3);
  });

  it('Drum-Synthese (Kick) nutzt den oversampelten Soft-Clipper, deterministisch, Laenge unveraendert', () => {
    const k = renderKick(0.4, SR);
    expect(k.length).toBe(19200);
    expect(k).toEqual(renderKick(0.4, SR));
    expect(Math.abs(k[0])).toBeGreaterThan(0.1);
  });

  it('Mastering: die harte ±ceiling-Sicherung greift auch bei heissem Sinus nahe 0,4·Fs nicht (kein Saettiger im Pfad)', () => {
    const core = new MasteringDynamics(SR, 2);
    const block = [new Float32Array(N), new Float32Array(N)];
    let peak = 0;
    for (let b = 0; b < 400; b++) {
      for (let i = 0; i < N; i++) {
        const v = aliasTestSample(b * N + i, 2); // +6 dBFS
        block[0][i] = v;
        block[1][i] = v;
      }
      core.process(block, 0, N);
      if (b > 20) for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(block[0][i]));
    }
    expect(core.safetyClipCount).toBe(0);
    expect(peak).toBeLessThanOrEqual(core.ceiling + 1e-6);
    // Lookahead unveraendert (5 ms).
    expect(core.lookaheadSamples).toBe(masteringLookaheadSamples(SR));
  });
});
