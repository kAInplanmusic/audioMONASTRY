// @vitest-environment node
/**
 * RT-AUDIT-P2-016: Parameter-Glättung gegen Zipper-Geräusche
 * ==========================================================
 * Vorher sprang ein Parameter pro Block (Port-Nachricht → sofortiger Wert), was
 * bei Gain/Pan/EQ hörbare Sprünge (Zipper) erzeugt. `AudioParameter.nextSmoothed`
 * glättet pro Sample mit einer One-Pole (Zeitkonstante 10 ms); der `GainNode`
 * nutzt sie im Sample-Loop.
 */
import { describe, expect, it } from 'vitest';
import { AudioParameter } from '../src/core/audio/AudioGraph';
import { GainNode } from '../src/core/audio/nodes/basicNodes';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { SourceNode } from '../src/core/audio/nodes/basicNodes';
import type { IProcessingContext } from '../src/core/audio/types';

const SR = 48000;

describe('RT-AUDIT-P2-016 · One-Pole-Glättung', () => {
  it('Sprung 0→1 erreicht nach 10 ms ca. 63 % (1 − 1/e)', () => {
    const p = new AudioParameter('g', 0, 1, 0);
    // Erster Aufruf startet beim aktuellen Wert (0).
    expect(p.nextSmoothed(SR)).toBe(0);
    p.setValue(1);
    let v = 0;
    for (let i = 0; i < SR * 0.01; i++) v = p.nextSmoothed(SR); // 10 ms
    expect(v).toBeGreaterThan(0.6);
    expect(v).toBeLessThan(0.66);
    // Nach ~5 Zeitkonstanten ist der Zielwert praktisch erreicht.
    for (let i = 0; i < SR * 0.04; i++) v = p.nextSmoothed(SR);
    expect(v).toBeGreaterThan(0.99);
  });

  it('kein Sample-Sprung > 0,01 bei einem Gain-Sprung 0→1 (GainNode)', () => {
    const graph = new AudioGraph();
    const dc = new Float32Array(128).fill(1);
    const src = new SourceNode('src', [dc]);
    const gain = new GainNode('g', 0);
    graph.addNode(src);
    graph.addNode(gain);
    graph.connect(src.outputs[0], gain.inputs[0]);

    const ctx = (b: number): IProcessingContext => ({
      sampleRate: SR, bufferSize: 128, quantum: 128 / SR, currentTime: (b * 128) / SR,
    });

    // Einschwingen bei 0 (Ausgang still).
    graph.process(ctx(0));
    expect(gain.outputs[0].buffer?.[0].every((x) => x === 0)).toBe(true);

    // Sprung auf 1: über 10 Blöcke rendern und die maximale Änderung zwischen
    // zwei aufeinanderfolgenden Ausgangs-Samples prüfen.
    gain.gain.setValue(1);
    let prev = 0;
    let maxJump = 0;
    for (let b = 1; b <= 20; b++) {
      graph.process(ctx(b));
      const out = gain.outputs[0].buffer![0];
      for (let i = 0; i < out.length; i++) {
        maxJump = Math.max(maxJump, Math.abs(out[i] - prev));
        prev = out[i];
      }
    }
    expect(maxJump).toBeLessThan(0.01);
    // Und der Ausgang folgt dem Ziel (kein Steckenbleiben; 20 Blöcke ≈ 53 ms = 5 τ).
    expect(prev).toBeGreaterThan(0.99);
  });
});
