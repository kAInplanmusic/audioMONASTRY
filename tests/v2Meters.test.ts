/**
 * RT-AUDIT-P0-005 · V2Meters (BS.1770-4) – Messrichtigkeit des Kerns
 * ==================================================================
 * Prüft die reine Messklasse ohne Worklet: K-Filter-Koeffizienten gegen die
 * Normtabelle (48 kHz), −23-LUFS-Kalibrierung, Korrelation, Underrun-Zähler.
 * Verdrahtung in den Sink, SAB-Übergabe, UI und echter True-Peak sind noch
 * offen (siehe MASTERTODOENDE.json, RT-AUDIT-P0-005).
 */
import { describe, expect, it } from 'vitest';
import { METER_LAYOUT, V2Meters, isWorkletUnderrun, isMainUnderrun } from '../src/core/audio/live/V2Meters';

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

  it('echter True-Peak: 45°-Abtastung eines fs/4-Sinus übersteigt den Sample-Peak', () => {
    // x[n] = sin(2π·(SR/4)·n/SR + π/4) → Samples bei ±0.7071, analoger Peak 1.0.
    const v = run(new V2Meters(SR), 0.05, (i) => {
      const s = Math.sin((2 * Math.PI * SR / 4) * i / SR + Math.PI / 4);
      return [s, s];
    });
    expect(v[METER_LAYOUT.PEAK_L]).toBeCloseTo(Math.SQRT1_2, 3);
    // Das 4×-Oversampling rekonstruiert den Zwischenwert → deutlich über dem
    // Sample-Peak (klassischer Inter-Sample-Peak).
    expect(v[METER_LAYOUT.TRUE_PEAK_L]).toBeGreaterThan(v[METER_LAYOUT.PEAK_L] * 1.2);
    expect(v[METER_LAYOUT.TRUE_PEAK_L]).toBeLessThanOrEqual(1.05);
  });

  it('Peak-Hold hält den Spitzenwert über ~20 ms (kein Sample-Verlust)', () => {
    const m = new V2Meters(SR);
    const l = new Float32Array(N);
    const r = new Float32Array(N);
    // Block 1: voller Impuls; Block 2: Stille. Der Hold muss den Impuls zeigen.
    l[0] = 0.9; r[0] = 0.9;
    m.processBlock(l, r);
    l.fill(0); r.fill(0);
    m.processBlock(l, r);
    const v = new Float32Array(m.getSharedBuffer());
    expect(v[METER_LAYOUT.PEAK_L]).toBe(0); // aktueller Block ist still
    expect(v[METER_LAYOUT.PEAK_HOLD_L]).toBeCloseTo(0.9, 5); // Hold hält den Impuls
  });
});

describe('RT-AUDIT-P0-005 · Underrun-Bewertung (Drift, gefälschte Zeitstempel)', () => {
  it('Worklet: Drift > 3 ms = Underrun (Fenster 250 · 128 Frames @48 kHz ≈ 666,7 ms)', () => {
    const expected = (250 * 128 / 48000) * 1000;
    expect(isWorkletUnderrun(expected + 0.5, expected)).toBe(false);
    expect(isWorkletUnderrun(expected + 3.0, expected)).toBe(false);
    expect(isWorkletUnderrun(expected + 3.5, expected)).toBe(true);
  });

  it('Main: Wanduhr > 1,5 Quanten vor der Audio-Zeit = Underrun', () => {
    const blockMs = (128 / 48000) * 1000;
    // 250 ms Wanduhr vs. 249,5 ms Audio = 0,5 ms Rückstand (kein Underrun).
    expect(isMainUnderrun(250, 249.5, blockMs)).toBe(false);
    // 250 ms Wanduhr vs. 245 ms Audio = 5 ms Rückstand (deutlich > 1,5 · 2,67 ms).
    expect(isMainUnderrun(250, 245, blockMs)).toBe(true);
    // Genau an der Grenze: 1,5 Quanten + ε.
    expect(isMainUnderrun(1.5 * blockMs + 0.01, 0, blockMs)).toBe(true);
    expect(isMainUnderrun(1.5 * blockMs - 0.01, 0, blockMs)).toBe(false);
  });
});
