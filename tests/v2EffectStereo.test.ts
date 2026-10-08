/**
 * RT-AUDIT-P1-011 · EffectNode: Zustand pro Kanal (Stereo-Isolation)
 * ==================================================================
 * Vorher liefen L und R verschachtelt durch EINE Delay-Line: ein Impuls nur
 * links erzeugte Energie rechts (gemessen 0,435), Comb-Echos kamen nach halber
 * Zeit (600 statt 1200 Samples) und Crusher/LFO liefen doppelt so schnell.
 */
import { describe, expect, it } from 'vitest';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { SourceNode } from '../src/core/audio/nodes/basicNodes';
import { EffectNode } from '../src/core/audio/nodes/processingNodes';

const SR = 48000;
const N = 128;
const ctx = (b: number) => ({ sampleRate: SR, bufferSize: N, quantum: N / SR, currentTime: (b * N) / SR });

function rig(channels: 1 | 2) {
  const g = new AudioGraph();
  const src = new SourceNode('s', channels === 2 ? [new Float32Array(N), new Float32Array(N)] : [new Float32Array(N)]);
  const fx = new EffectNode('fx');
  fx.wet.setValue(1);
  g.addNode(src); g.addNode(fx); g.connect(src.outputs[0], fx.inputs[0]); g.compile();
  return { g, src, fx };
}

/** Rendert `blocks` Blöcke; `feed(b)` liefert die Eingangskanäle je Block. */
function run(channels: 1 | 2, blocks: number, feed: (b: number) => Float32Array[]): Float32Array[] {
  const { g, src, fx } = rig(channels);
  const out = Array.from({ length: channels }, () => new Float32Array(blocks * N));
  for (let b = 0; b < blocks; b++) {
    src.sourceBuffer = feed(b);
    g.process(ctx(b));
    const o = fx.outputs[0].buffer!;
    for (let c = 0; c < channels; c++) out[c].set(o[c], b * N);
  }
  return out;
}

const impulseLeft = (b: number): Float32Array[] => {
  const L = new Float32Array(N);
  if (b === 0) L[0] = 1;
  return [L, new Float32Array(N)];
};

describe('RT-AUDIT-P1-011 · EffectNode Stereo-Isolation', () => {
  it('Impuls nur links → rechter Kanal bleibt exakt still', () => {
    const [, right] = run(2, 100, impulseLeft);
    expect(right.every((v) => v === 0)).toBe(true);
  });

  it('Impuls links verhält sich exakt wie derselbe Impuls im Mono-Lauf (Delay-Zeiten nicht halbiert)', () => {
    const [mono] = run(1, 60, (b) => [impulseLeft(b)[0]]);
    const [left] = run(2, 60, impulseLeft);
    for (let i = 0; i < mono.length; i++) expect(left[i]).toBeCloseTo(mono[i], 6);
  });

  it('Stereo mit identischem L/R = Mono-Verarbeitung je Kanal (kein Übersprechen, gleiche Zeitbasis)', () => {
    const feedMono = (b: number) => {
      const x = new Float32Array(N);
      for (let i = 0; i < N; i++) x[i] = Math.sin((2 * Math.PI * 220 * (b * N + i)) / SR) * 0.5;
      return x;
    };
    const [mono] = run(1, 80, (b) => [feedMono(b)]);
    const [l, r] = run(2, 80, (b) => [feedMono(b), feedMono(b)]);
    for (let i = 0; i < mono.length; i++) {
      expect(l[i]).toBeCloseTo(mono[i], 6);
      expect(r[i]).toBeCloseTo(mono[i], 6);
    }
  });

  it('allokationsfrei im Block-Takt: Ausgangspuffer bleibt über Blöcke dieselbe Referenz', () => {
    const { g, src, fx } = rig(2);
    let first: Float32Array[] | null = null;
    for (let b = 0; b < 200; b++) {
      src.sourceBuffer = impulseLeft(b);
      g.process(ctx(b));
      if (b === 10) first = fx.outputs[0].buffer;
    }
    expect(fx.outputs[0].buffer).toBe(first);
  });

  it('reset() leert alle Kanalzustände', () => {
    const { g, src, fx } = rig(2);
    for (let b = 0; b < 20; b++) { src.sourceBuffer = impulseLeft(b); g.process(ctx(b)); }
    fx.reset();
    src.sourceBuffer = [new Float32Array(N), new Float32Array(N)];
    g.process(ctx(21));
    const o = fx.outputs[0].buffer!;
    expect(o[0].every((v) => v === 0) && o[1].every((v) => v === 0)).toBe(true);
  });
});
