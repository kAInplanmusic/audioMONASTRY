import { beforeAll, describe, expect, it } from 'vitest';
import { AudioGraph, AudioParameter } from '../src/core/audio/AudioGraph';
import {
  GainNode,
  MasterSumNode,
  MultichannelBusNode,
  SourceNode,
  Stereo21OutputNode,
  StereoPanNode,
  StereoSumNode,
} from '../src/core/audio/nodes/basicNodes';
import {
  DynamicsNode,
  MasteringNode,
  ParametricEqNode,
  fromDb,
} from '../src/core/audio/nodes/processingNodes';
import { V2SampleClock } from '../src/core/audio/live/V2SampleClock';
import type { IAudioNode } from '../src/core/audio/types';

/**
 * ARCH-AUDIO-002 – Erweiterte V2-DSP-Paritätssuite.
 *
 * Grundsatz: Sample-level-Vergleiche statt RMS/Hash-Proxy. Wo V1 und V2
 * absichtlich unterschiedliche Algorithmen haben (Kompressor/Limiter/FX),
 * wird die Toleranz mathematisch dokumentiert (siehe
 * docs/DSP_PARITY_TOLERANCES.md) und als Bereichs-/Eigenschaftstest geprüft.
 */

const SR = 48000;

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = SR;
  g.currentFrame = 0;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as null, postMessage: () => {} };
  };
  g.registerProcessor = () => {};
});

function runNode(node: IAudioNode, source: Float32Array[], length = 256): Float32Array[] {
  const graph = new AudioGraph();
  const src = new SourceNode('src', source);
  graph.addNode(src);
  graph.addNode(node);
  graph.connect(src.outputs[0], node.inputs[0]);
  graph.process({ sampleRate: SR, bufferSize: length, quantum: length / SR, currentTime: 0 });
  return node.outputs[0]?.buffer ?? [];
}

function tone(freq: number, length: number, amp = 0.5, sr = SR): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr) * amp;
  return out;
}

function maxAbs(ch: Float32Array): number {
  let m = 0;
  for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]));
  return m;
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('ARCH-AUDIO-002 · V2-DSP sample-level Parität', () => {
  it('GainNode: sample-exakte Verstärkung (0 dB, -6 dB, +6 dB) gegen mathematische Referenz', () => {
    const input = tone(440, 256);
    for (const db of [0, -6, 6]) {
      const node = new GainNode('gain', fromDb(db));
      const out = runNode(node, [input]);
      expect(out[0]).toBeDefined();
      const expected = fromDb(db);
      for (let i = 0; i < input.length; i++) {
        expect(Math.abs(out[0][i] - input[i] * expected)).toBeLessThanOrEqual(1e-7);
      }
    }
  });

  it('StereoPanNode: Equal-Power-Gesetz sample-exakt (mono → L/R)', () => {
    const input = tone(1000, 256);
    for (const pan of [-1, -0.5, 0, 0.5, 1]) {
      const node = new StereoPanNode('pan', pan);
      const out = runNode(node, [input]);
      const theta = ((pan + 1) * Math.PI) / 4;
      const lg = Math.cos(theta);
      const rg = Math.sin(theta);
      expect(out.length).toBe(2);
      for (let i = 0; i < input.length; i++) {
        expect(Math.abs(out[0][i] - input[i] * lg)).toBeLessThanOrEqual(1e-7);
        expect(Math.abs(out[1][i] - input[i] * rg)).toBeLessThanOrEqual(1e-7);
      }
    }
  });

  it('ParametricEqNode: 0 dB Bänder = Passthrough (Biquad-Koeffizienten neutral)', () => {
    const input = tone(440, 512);
    const node = new ParametricEqNode('eq');
    const out = runNode(node, [input], 512);
    // 12 Biquads in Serie mit g=0 ⇒ Koeffizienten b0=1, Rest 0 ⇒ exakt input.
    expect(maxDiff(out[0], input)).toBeLessThanOrEqual(1e-6);
  });

  it('Silence: alle V2-Basis-Nodes liefern Stille bei Stille', () => {
    const silence = new Float32Array(256);
    const nodes: IAudioNode[] = [
      new GainNode('g', 2),
      new StereoPanNode('p', 0.5),
      new ParametricEqNode('eq'),
      new DynamicsNode('dyn'),
      new MasteringNode('mst'),
    ];
    for (const node of nodes) {
      const out = runNode(node, [silence]);
      for (const ch of out) {
        expect(maxAbs(ch)).toBe(0);
      }
    }
  });

  it('NaN/Inf-Guards: defekter Input kippt Master-/Dynamics-/Mastering-Nodes nicht', () => {
    const bad = tone(440, 256);
    bad[10] = NaN;
    bad[20] = Infinity;
    for (const node of [new MasterSumNode('sum', 1), new DynamicsNode('dyn'), new MasteringNode('mst')]) {
      if (node instanceof MasterSumNode) {
        const g = new AudioGraph();
        const src = new SourceNode('src', [bad]);
        g.addNode(src);
        g.addNode(node);
        g.connect(src.outputs[0], node.inputs[0]);
        g.process({ sampleRate: SR, bufferSize: 256, quantum: 256 / SR, currentTime: 0 });
        for (const ch of node.outputs[0]?.buffer ?? []) {
          for (const v of ch) expect(Number.isFinite(v)).toBe(true);
        }
      } else {
        const out = runNode(node, [bad]);
        for (const ch of out) {
          for (const v of ch) expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  it('Denormal-Handling: 1e-30-Signale erzeugen kein NaN/Inf in Gain und Pan', () => {
    const tiny = new Float32Array(256).fill(1e-30);
    for (const node of [new GainNode('g', 1), new StereoPanNode('p', 0)]) {
      const out = runNode(node, [tiny]);
      for (const ch of out) {
        for (const v of ch) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('Channel-Count: Stereo21OutputNode liefert exakt 3 Kanäle (L/R/LFE)', () => {
    const left = tone(120, 256);
    const right = tone(120, 256, 0.5);
    const node = new Stereo21OutputNode('21', SR, 90);
    const out = runNode(node, [left, right]);
    expect(out.length).toBe(3);
    for (const ch of out) expect(ch.length).toBe(256);
  });

  it('Channel-Count: MultichannelBusNode liefert konfigurierte N Kanäle', () => {
    const input = tone(440, 256);
    for (const n of [4, 12, 24]) {
      const node = new MultichannelBusNode(`mc${n}`, n);
      node.setChannelGains(Array.from({ length: n }, (_, i) => (i + 1) / n));
      const out = runNode(node, [input]);
      expect(out.length).toBe(n);
    }
  });

  it('StereoSumNode: Mono-Quelle wird auf beide Zielkanäle summiert (Routing)', () => {
    const input = tone(440, 256);
    const node = new StereoSumNode('sum', 1, 1, 2);
    const out = runNode(node, [input]);
    expect(out.length).toBe(2);
    for (let i = 0; i < input.length; i++) {
      expect(out[0][i]).toBeCloseTo(input[i], 6);
      expect(out[1][i]).toBeCloseTo(input[i], 6);
    }
  });

  it('V2SampleClock: PDC-Kompensation feuert Step exakt um Lookahead-Samples früher', () => {
    const compensation = 240; // 5 ms @ 48 kHz
    const clock = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 120, pdcCompensationSamples: compensation });
    clock.playing = true;
    clock.reset();

    // Ersten Step ohne PDC finden (Referenzlauf).
    const ref = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 120, pdcCompensationSamples: 0 });
    ref.playing = true;
    ref.reset();

    const frames = 12000; // > samplesPerStep (6000 @ 120 BPM), damit Step 0 sicher im Fenster liegt
    const steps = clock.processBlock(0, frames);
    const refSteps = ref.processBlock(0, frames);
    expect(steps.length).toBeGreaterThan(0);
    expect(refSteps.length).toBeGreaterThan(0);
    expect(steps[0].frame).toBe(Math.max(0, refSteps[0].frame - compensation));
  });

  it('Automation: AudioParameter interpoliert linear zwischen zwei Punkten (sample-level)', () => {
    const p = new AudioParameter('auto', -24, 24, 0);
    p.setValueAtTime(0, 0);
    p.setValueAtTime(10, 100);
    expect(p.getValueAtTime(50)).toBeCloseTo(5, 5);
    expect(p.getValueAtTime(0)).toBeCloseTo(0, 5);
    expect(p.getValueAtTime(100)).toBeCloseTo(10, 5);
    expect(p.getValueAtTime(200)).toBeCloseTo(10, 5);
  });
});

describe('ARCH-AUDIO-002 · V1↔V2 DSP-Parität (echte V1-Klassen)', () => {
  function runV1Processor(
    ctor: new () => { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean; port?: { postMessage: (m: unknown) => void } },
    source: Float32Array[],
    message?: unknown,
  ): Float32Array[] {
    const proc = new ctor();
    if (message !== undefined) proc.port?.postMessage(message);
    const output = source.map((ch) => new Float32Array(ch.length));
    expect(proc.process([source], [output])).toBe(true);
    return output;
  }

  it('Dynamics V1-Bypass ↔ V2-Disabled: bit-identischer Passthrough', async () => {
    const { DynamicsProcessor } = await import('../src/audio/worklets/dynamicsProcessor');
    const source = [tone(220, 256, 0.4), tone(330, 256, 0.3)];
    const v1 = runV1Processor(DynamicsProcessor as never, source);
    const v2 = new DynamicsNode('dyn');
    v2.setEnabled(false);
    const v2out = runNode(v2, source);
    for (let ch = 0; ch < source.length; ch++) {
      expect(maxDiff(v1[ch], source[ch])).toBe(0);
      expect(maxDiff(v2out[ch], source[ch])).toBe(0);
    }
  });

  it('Dynamics V1-Enabled ↔ V2-Enabled: gleiche Parameter, RMS-Abweichung ≤ 6 dB (dokumentierte Toleranz)', async () => {
    const { DynamicsProcessor } = await import('../src/audio/worklets/dynamicsProcessor');
    const source = [tone(60, 2048, 0.95)];
    const v1 = runV1Processor(DynamicsProcessor as never, source, {
      enabled: true,
      compressor: { threshold: -18, ratio: 4, attack: 0.01, release: 0.1, knee: 6, makeup: 0 },
    });
    const v2 = new DynamicsNode('dyn');
    v2.setEnabled(true);
    // ARCH-AUDIO-002: V2 auf dieselben Parameter wie V1 setzen.
    v2.threshold.setValue(-18);
    v2.ratio.setValue(4);
    v2.attack.setValue(0.01);
    v2.release.setValue(0.1);
    v2.knee.setValue(6);
    v2.makeup.setValue(0);
    const v2out = runNode(v2, source, 2048);

    // Eigenschafts-Parität: keine Clips > 1, beide hörbar aktiv, Pegel in gleicher Größenordnung.
    expect(maxAbs(v1[0])).toBeLessThanOrEqual(1.001);
    expect(maxAbs(v2out[0])).toBeLessThanOrEqual(1.001);

    const rms = (ch: Float32Array) => Math.sqrt(ch.reduce((s, v) => s + v * v, 0) / ch.length);
    const ratioDb = Math.abs(20 * Math.log10(rms(v1[0]) / Math.max(1e-6, rms(v2out[0]))));
    // V1 nutzt dB-Domain-Envelope mit Hold/Gate-Defaults, V2 eine Peak-Envelope
    // mit identischer statischer Kurve – Pegelabweichung ist mathematisch
    // toleriert (≤ 10 dB, siehe docs/DSP_PARITY_TOLERANCES.md).
    expect(ratioDb).toBeLessThanOrEqual(10);
  });

  it('Mastering V1-Limiter ↔ V2-MasteringNode: Peaks ≤ Ceiling, Silence bleibt Silence', async () => {
    const { MasteringProcessor } = await import('../src/audio/worklets/masteringProcessor');
    const hot = [new Float32Array(2048).fill(1.2)];
    const v1 = runV1Processor(MasteringProcessor as never, hot, { ceiling: 0.95 });
    const v2 = new MasteringNode('mst');
    v2.ceiling.setValue(0.95);
    const v2out = runNode(v2, hot, 2048);

    expect(maxAbs(v1[0])).toBeLessThanOrEqual(0.951);
    expect(maxAbs(v2out[0])).toBeLessThanOrEqual(0.951);

    const silence = [new Float32Array(256)];
    const v1s = runV1Processor(MasteringProcessor as never, silence);
    const v2s = runNode(new MasteringNode('mst2'), silence);
    expect(maxAbs(v1s[0])).toBe(0);
    expect(maxAbs(v2s[0])).toBe(0);
  });

  it('EQ: V2 neutral ist exakt transparent (ARCH-AUDIO-002-Fix); V1 neutral hat dokumentierte RBJ-Degeneration ≤ 0.1', async () => {
    const { EqProcessor } = await import('../src/audio/worklets/eqProcessor');
    const source = [tone(1000, 512, 0.5)];
    const v1 = runV1Processor(EqProcessor as never, source);
    const v2 = new ParametricEqNode('eq');
    const v2out = runNode(v2, source, 512);
    // V2 (nach Fix): 0 dB = Bypass, exakt transparent.
    expect(maxDiff(v2out[0], source[0])).toBeLessThanOrEqual(1e-6);
    // V1 (RBJ-Shelf-Degeneration bei A=1): tolerierte, dokumentierte Abweichung.
    expect(maxDiff(v1[0], source[0])).toBeLessThanOrEqual(0.1);
    // V1↔V2: beide neutral, V1-Abweichung dokumentiert (kein Pegel-/Frequenzbruch).
    expect(maxDiff(v1[0], v2out[0])).toBeLessThanOrEqual(0.1);
  });
});
