// @vitest-environment node
/**
 * RT-AUDIT-P1-009: Sample-Resampling auf die Context-Rate.
 * =========================================================
 * Vorher las der Sink die Rohdaten per Nearest-Neighbor (44,1-kHz-Samples bei
 * 48 kHz → hörbares Aliasing, SINAD ~14 dB). Geprüft wird:
 *   - der portable Sinc-Resampler (SINAD eines 5-kHz-Sinus >= 60 dB bei 44,1→48k),
 *   - unveränderte Rückgabe, wenn fromRate === toRate,
 *   - `resampleToRate` fällt ohne OfflineAudioContext (Node) auf den Sinc-Weg
 *     zurück und liefert dasselbe Ergebnis,
 *   - die Loop-Grenze des Sink-Sample-Players erzeugt keinen Klick
 *     (Sprung < 0,05) – inkl. Hermite-Interpolation bei rate != 1.
 */
import { describe, expect, it } from 'vitest';
import { resampleSincToRate, resampleToRate } from '../src/core/audio/sampleResample';
import { V2SinkEngine } from '../src/core/audio/live/V2SinkEngine';

const SR = 48000;
const N = 128;

/** SINAD eines Sinus der Frequenz f0 im Ausgang (Referenz-Rate SR). */
function sinad(out: Float32Array, f0: number, rate = SR): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < out.length; i++) {
    re += out[i] * Math.cos((2 * Math.PI * f0 * i) / rate);
    im += out[i] * Math.sin((2 * Math.PI * f0 * i) / rate);
  }
  const a = (2 * Math.hypot(re, im)) / out.length;
  const ptot = out.reduce((s, v) => s + v * v, 0) / out.length;
  const psig = (a * a) / 2;
  return 10 * Math.log10(psig / Math.max(1e-20, ptot - psig));
}

describe('RT-AUDIT-P1-009: resampleSincToRate', () => {
  it('5-kHz-Sinus 44,1 → 48 kHz: SINAD >= 60 dB', () => {
    const src = new Float32Array(44100 * 2);
    for (let i = 0; i < src.length; i++) src[i] = 0.25 * Math.sin((2 * Math.PI * 5000 * i) / 44100);
    const r = resampleSincToRate(src, null, 44100, SR);
    expect(r.sourceRate).toBe(SR);
    // Länge skaliert um das Ratenverhältnis.
    expect(r.left.length).toBe(Math.floor(src.length / (44100 / SR)));
    // Der stationäre (interpolierte) Teil – die ersten Samples abschneiden.
    const steady = r.left.subarray(200, 200 + SR);
    expect(sinad(steady, 5000)).toBeGreaterThan(60);
  });

  it('fromRate === toRate → unverändert (gleiche Referenz)', () => {
    const src = new Float32Array([0.1, -0.2, 0.3]);
    const r = resampleSincToRate(src, null, SR, SR);
    expect(r.left).toBe(src);
    expect(r.sourceRate).toBe(SR);
  });

  it('Stereo: rechter Kanal wird ebenfalls umgerechnet', () => {
    const len = 44100 * 2;
    const l = new Float32Array(len);
    const r = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      l[i] = 0.2 * Math.sin((2 * Math.PI * 1000 * i) / 44100);
      r[i] = 0.2 * Math.sin((2 * Math.PI * 2000 * i) / 44100);
    }
    const out = resampleSincToRate(l, r, 44100, SR);
    expect(out.right).not.toBeNull();
    expect(out.right!.length).toBe(out.left.length);
    const li = out.left.subarray(200, 200 + SR);
    const ri = out.right!.subarray(200, 200 + SR);
    expect(sinad(li, 1000)).toBeGreaterThan(60);
    expect(sinad(ri, 2000)).toBeGreaterThan(60);
  });

  it('resampleToRate (Node, ohne OfflineAudioContext) nutzt den Sinc-Fallback', async () => {
    const src = new Float32Array(44100);
    for (let i = 0; i < src.length; i++) src[i] = 0.25 * Math.sin((2 * Math.PI * 5000 * i) / 44100);
    const asyncRes = await resampleToRate(src, null, 44100, SR);
    const syncRes = resampleSincToRate(src, null, 44100, SR);
    expect(asyncRes.sourceRate).toBe(SR);
    expect(asyncRes.left.length).toBe(syncRes.left.length);
    for (let i = 0; i < asyncRes.left.length; i++) {
      if (asyncRes.left[i] !== syncRes.left[i]) throw new Error(`Abweichung an ${i}`);
    }
  });

  it('resampleToRate: fromRate === toRate → unverändert', async () => {
    const src = new Float32Array([0.5, 0.25]);
    const r = await resampleToRate(src, null, SR, SR);
    expect(r.left).toBe(src);
  });
});

describe('RT-AUDIT-P1-009: Sink-Sample-Player Loop-Grenze ohne Klick', () => {
  const ctx = (block: number) => ({ sampleRate: SR, bufferSize: N, quantum: N / SR, currentTime: (block * N) / SR });

  it('geloopetes Sample (ganze Perioden) springt an der Loop-Grenze < 0,05', () => {
    const engine = new V2SinkEngine(SR, N);
    engine.setMasterMastering(0, 1, 1, 1);
    // 100 Hz, exakt 100 Perioden in 1 s → Start- und Endwert passen zusammen.
    const len = SR;
    const buf = new Float32Array(len);
    for (let i = 0; i < len; i++) buf[i] = 0.25 * Math.sin((2 * Math.PI * 100 * i) / SR);
    engine.setSampleBuffer('channel2', buf, null, SR);
    // rate 1,02 → Hermite-Pfad (advance != 1), Loop aktiv.
    engine.triggerSample('channel2', { loop: true, rate: 1.02 });

    const out: number[] = [];
    for (let b = 0; b < 600; b++) {
      const r = engine.render(ctx(b));
      for (let i = 0; i < N; i++) out.push(r[0][i]);
    }
    let maxJump = 0;
    for (let i = 1; i < out.length; i++) maxJump = Math.max(maxJump, Math.abs(out[i] - out[i - 1]));
    expect(maxJump).toBeLessThan(0.05);
  });
});
