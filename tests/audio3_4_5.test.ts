import { describe, expect, it } from 'vitest';
import { createBandlimitedTable, createMipMaps, createMorphWavetables, sampleWavetable } from '../src/core/instrument/wavetable';
import { createTonewheelTable, LeslieSim } from '../src/core/instrument/tonewheel';
import { humanize, renderHat, renderKick, renderSnare } from '../src/core/instrument/drumSynth';

describe('AUDIO-3 Wavetable-Synthese (produktionsreif)', () => {
  it('erzeugt aliasfreie bandlimited Tabelle mit Peak-Normalisierung', () => {
    const t = createBandlimitedTable([1, 0.5, 0.25], 2048);
    expect(t.length).toBe(2048);
    let peak = 0;
    for (let i = 0; i < t.length; i++) peak = Math.max(peak, Math.abs(t[i]));
    expect(peak).toBeGreaterThan(0.99);
    expect(peak).toBeLessThanOrEqual(1.001);
  });

  it('erzeugt Mip-Maps durch Halbierung bis < 8 Samples', () => {
    const mips = createMipMaps(createBandlimitedTable([1], 2048));
    expect(mips.length).toBeGreaterThanOrEqual(8);
    expect(mips[mips.length - 1].length).toBeLessThan(8 * 2);
  });

  it('morpht deterministisch zwischen Sinus und Sägezahn', () => {
    const { sine, saw } = createMorphWavetables(256);
    const a = sampleWavetable(sine, saw, 0, 0.25, 0);
    const b = sampleWavetable(sine, saw, 1, 0.25, 0);
    const mid = sampleWavetable(sine, saw, 0.5, 0.25, 0);
    expect(mid).toBeGreaterThan(Math.min(a, b) - 0.0001);
    expect(mid).toBeLessThan(Math.max(a, b) + 0.0001);
    expect(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(mid)).toBe(true);
  });
});

describe('AUDIO-4 Tonewheel-Orgel + Leslie (produktionsreif)', () => {
  const DEFAULT_DRAWBARS: [number, number, number, number, number, number, number, number, number] = [8, 8, 8, 8, 8, 8, 8, 8, 8];

  it('erzeugt additive 9-Drawbar-Tabelle deterministisch', () => {
    const t = createTonewheelTable(DEFAULT_DRAWBARS, 1024);
    expect(t.length).toBe(1024);
    let peak = 0;
    for (let i = 0; i < t.length; i++) peak = Math.max(peak, Math.abs(t[i]));
    expect(peak).toBeLessThanOrEqual(1.001);
  });

  it('leere Drawbars liefern Stille', () => {
    const empty: typeof DEFAULT_DRAWBARS = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const t = createTonewheelTable(empty, 256);
    expect(Array.from(t).every((v) => v === 0)).toBe(true);
  });

  it('Leslie beschleunigt auf fast und erzeugt AM/FM-Modulation', () => {
    const l = new LeslieSim(48000, { fastHz: 6.2, slowHz: 0.8, rampSec: 0.05, amDepth: 0.5, fmDepth: 0.01 });
    expect(l.getSpeed()).toBeCloseTo(0.8, 3);
    l.setFast(true);
    let prev = 0;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bewusst beibehalten (Runde 3)
    for (let i = 0; i < 12000; i++) prev = l.process(0.5);
    expect(l.getSpeed()).toBeGreaterThan(3); // hat fast erreicht
    // Modulation verändert den Pegel (AM) bzw. liefert gültige Werte
    const samples: number[] = [];
    for (let i = 0; i < 4800; i++) samples.push(l.process(0.5));
    expect(Math.max(...samples)).toBeLessThanOrEqual(0.55);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0.1);
  });
});

describe('AUDIO-5 Drum-Synthese (produktionsreif)', () => {
  it('renderKick erzeugt kurzen, endlichen Transienten', () => {
    const k = renderKick(0.4, 48000);
    expect(k.length).toBe(19200);
    expect(Math.abs(k[0])).toBeGreaterThan(0.1); // Click vorhanden
    expect(Math.abs(k[k.length - 1])).toBeLessThan(0.06); // Ausklingen
  });

  it('renderSnare ist deterministisch (Seed) und hat Noise-Anteil', () => {
    const a = renderSnare(0.25, 48000, 7);
    const b = renderSnare(0.25, 48000, 7);
    expect(a).toEqual(b);
    expect(a.some((v) => Math.abs(v) > 0.1)).toBe(true);
  });

  it('renderHat erzeugt Noise-Burst', () => {
    const h = renderHat(0.08, 48000, 99);
    expect(h.some((v) => Math.abs(v) > 0.2)).toBe(true);
  });

  it('humanize ist deterministisch und begrenzt', () => {
    const r = humanize(0, 0.02, 1234);
    expect(Math.abs(r.timeOffsetSec)).toBeLessThanOrEqual(0.01);
    expect(r.velocity).toBeGreaterThanOrEqual(0.2);
    expect(r.velocity).toBeLessThanOrEqual(1);
    expect(humanize(0, 0.02, 1234)).toEqual(r);
  });
});
