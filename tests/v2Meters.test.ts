/**
 * RT-AUDIT-P0-005 · V2Meters (BS.1770-4) – Messrichtigkeit des Kerns
 * ==================================================================
 * Prüft die reine Messklasse ohne Worklet: K-Filter-Koeffizienten gegen die
 * Normtabelle (48 kHz), −23-LUFS-Kalibrierung, Korrelation, Underrun-Zähler.
 * Verdrahtung in den Sink, SAB-Übergabe, UI und echter True-Peak sind noch
 * offen (siehe MASTERTODOENDE.json, RT-AUDIT-P0-005).
 */
import { describe, expect, it } from 'vitest';
import { METER_LAYOUT, V2Meters } from '../src/core/audio/live/V2Meters';

const SR = 48000;
const N = 128;

function run(meters: V2Meters, seconds: number, fill: (i: number) => [number, number]): Float32Array {
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  let n = 0;
  for (let b = 0; b < Math.ceil((seconds * SR) / N); b++) {
    for (let i = 0; i < N; i++, n++) [l[i], r[i]] = fill(n);
    meters.processBlock(l, r);
  }
  return new Float32Array(meters.getSharedBuffer());
}

describe('RT-AUDIT-P0-005 · V2Meters', () => {
  it('1-kHz-Sinus in beiden Kanälen mit −23 dBFS Spitze misst −23 ± 0,5 LUFS (M und S)', () => {
    const a = 10 ** (-23 / 20);
    const v = run(new V2Meters(SR), 3.5, (i) => {
      const s = a * Math.sin((2 * Math.PI * 1000 * i) / SR);
      return [s, s];
    });
    expect(Math.abs(v[METER_LAYOUT.LUFS_M] + 23)).toBeLessThan(0.5);
    expect(Math.abs(v[METER_LAYOUT.LUFS_S] + 23)).toBeLessThan(0.5);
  });

  it('nur ein Kanal: 3 dB leiser als derselbe Sinus in beiden Kanälen', () => {
    const a = 10 ** (-23 / 20);
    const v = run(new V2Meters(SR), 3.5, (i) => [a * Math.sin((2 * Math.PI * 1000 * i) / SR), 0]);
    expect(Math.abs(v[METER_LAYOUT.LUFS_S] + 26.01)).toBeLessThan(0.5);
  });

  it('Korrelation: L = R → +1, L = −R → −1', () => {
    const sig = (i: number) => Math.sin(i * 0.05) * 0.5;
    expect(run(new V2Meters(SR), 0.01, (i) => [sig(i), sig(i)])[METER_LAYOUT.CORRELATION]).toBeCloseTo(1, 5);
    expect(run(new V2Meters(SR), 0.01, (i) => [sig(i), -sig(i)])[METER_LAYOUT.CORRELATION]).toBeCloseTo(-1, 5);
  });

  it('Stille → −70 LUFS, Peak 0', () => {
    const v = run(new V2Meters(SR), 0.5, () => [0, 0]);
    expect(v[METER_LAYOUT.LUFS_M]).toBe(-70);
    expect(v[METER_LAYOUT.PEAK_L]).toBe(0);
  });

  it('Underrun-Zähler zählen ganzzahlig im Float32-Layout (je Quelle getrennt)', () => {
    const m = new V2Meters(SR);
    m.recordUnderrun(true);
    m.recordUnderrun(true);
    m.recordUnderrun(false);
    const v = new Float32Array(m.getSharedBuffer());
    expect(v[METER_LAYOUT.UNDERRUNS_WORKLET]).toBe(2);
    expect(v[METER_LAYOUT.UNDERRUNS_MAIN]).toBe(1);
  });
});
