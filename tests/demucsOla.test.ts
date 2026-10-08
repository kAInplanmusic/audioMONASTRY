/**
 * RT-AUDIT-P2-018 · Demucs-Overlap-Add ohne Rand-Ausblendung
 * ==========================================================
 * Vorher waren die ersten/letzten ~1,95 s jedes Stems ein-/ausgeblendet, weil
 * auch Randsegmente eine Rampe ohne Nachbarn bekamen.
 */
import { describe, expect, it } from 'vitest';
import { DemucsOlaAccumulator, olaWeight } from '../src/ai/demucsOla';

/** Simuliert ein „Modell“, das den Eingang je Stem/Kanal unverändert ausgibt. */
function identityRun(signal: (i: number) => number, total: number, seg: number, ramp: number): Float32Array[][] {
  const hop = seg - ramp;
  const n = DemucsOlaAccumulator.chunkCount(total, seg, ramp);
  const ola = new DemucsOlaAccumulator(total, seg, ramp, 4, 2);
  for (let c = 0; c < n; c++) {
    const offset = c * hop;
    const out = new Float32Array(4 * 2 * seg);
    for (let s = 0; s < 4; s++) for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < seg; i++) {
        const idx = Math.min(offset + i, total - 1);
        out[(s * 2 + ch) * seg + i] = signal(idx);
      }
    }
    ola.add(offset, out, 4, c === 0, c === n - 1);
  }
  return ola.finalize();
}

describe('RT-AUDIT-P2-018 · Demucs-OLA', () => {
  it('konstantes Signal 1,0 über 3+ Segmente → überall 1,0 ± 1e-6 (auch an den Rändern)', () => {
    const seg = 4000; const ramp = 1000; const total = 10_500; // ungerade Länge → unregelmäßiges letztes Segment
    const stems = identityRun(() => 1, total, seg, ramp);
    for (const stem of stems) for (const ch of stem) {
      for (let i = 0; i < total; i++) expect(Math.abs(ch[i] - 1)).toBeLessThan(1e-6);
    }
  });

  it('beliebiges Signal wird exakt rekonstruiert (Identitätsmodell)', () => {
    const seg = 3000; const ramp = 750; const total = 9_871;
    const sig = (i: number) => Math.sin(i * 0.013) * 0.7 + Math.cos(i * 0.0007) * 0.2;
    const [drums] = identityRun(sig, total, seg, ramp);
    for (let i = 0; i < total; i++) expect(drums[0][i]).toBeCloseTo(sig(i), 5);
  });

  it('Signal kürzer als ein Segment: ein Chunk, keine Rampen', () => {
    const stems = identityRun(() => 0.5, 1234, 4000, 1000);
    expect(stems[3][1].every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it('Rampen nur zu echten Nachbarn', () => {
    expect(olaWeight(0, 100, 25, true, false)).toBe(1);   // erster Chunk: kein Fade-in
    expect(olaWeight(0, 100, 25, false, false)).toBe(0);  // mittlerer Chunk: Fade-in
    expect(olaWeight(99, 100, 25, false, true)).toBe(1);  // letzter Chunk: kein Fade-out
    expect(olaWeight(99, 100, 25, false, false)).toBeCloseTo(0.04); // mittlerer: Fade-out
  });

  it('NaN/Inf aus dem Modell werden zu 0, nicht zu NaN im Stem', () => {
    const ola = new DemucsOlaAccumulator(100, 100, 25, 1, 1);
    const out = new Float32Array(100).fill(1); out[10] = NaN; out[20] = Infinity;
    ola.add(0, out, 1, true, true);
    const [[ch]] = ola.finalize();
    expect(ch[10]).toBe(0); expect(ch[20]).toBe(0); expect(ch[30]).toBe(1);
  });
});
