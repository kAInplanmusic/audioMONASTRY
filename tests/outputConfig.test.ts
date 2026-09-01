import { describe, expect, it } from 'vitest';
import {
  createOutputConfig,
  designLinkwitzRileyCrossover,
  hasDedicatedSub,
  listSupportedLayoutIds,
} from '../src/core/output/OutputConfig';

describe('OutputConfig / 2.1-Crossover (P2-3)', () => {
  it('listet alle Layouts von stereo bis 24.2', () => {
    const ids = listSupportedLayoutIds();
    for (const id of ['stereo', '2.0', '2.1', '2.2', '12.0', '12.1', '12.2', '18.0', '18.1', '18.2', '24.0', '24.1', '24.2']) {
      expect(ids).toContain(id);
    }
    expect(createOutputConfig('24.2').channels).toHaveLength(26);
  });

  it('erkennt dedizierte Sub-Kanäle (.1/.2)', () => {
    expect(hasDedicatedSub('2.1')).toBe(true);
    expect(hasDedicatedSub('2.0')).toBe(false);
    expect(hasDedicatedSub('stereo')).toBe(false);
    expect(hasDedicatedSub('12.2')).toBe(true);
  });

  it('Linkwitz-Riley-Crossover liefert stabile, endliche Koeffizienten', () => {
    const c = designLinkwitzRileyCrossover(48000, 90);
    for (const coef of [...c.lowpass, ...c.highpass]) expect(Number.isFinite(coef)).toBe(true);
    // Biquad-Stabilität: |a1| < 2 und |a2| < 1
    expect(Math.abs(c.lowpass[3])).toBeLessThan(2);
    expect(Math.abs(c.lowpass[4])).toBeLessThan(1);
    expect(Math.abs(c.highpass[3])).toBeLessThan(2);
    expect(Math.abs(c.highpass[4])).toBeLessThan(1);
    // Sub-Pfad lässt DC passieren (b0+b1+b2 > 0), L/R-Hochpass blockt DC (~0)
    const lpDc = c.lowpass[0] + c.lowpass[1] + c.lowpass[2];
    const hpDc = c.highpass[0] + c.highpass[1] + c.highpass[2];
    expect(lpDc).toBeGreaterThan(0);
    expect(Math.abs(hpDc)).toBeLessThan(1e-4);
  });

  it('clamped Crossover-Frequenz (40–200 Hz)', () => {
    expect(designLinkwitzRileyCrossover(48000, 20).crossoverHz).toBe(40);
    expect(designLinkwitzRileyCrossover(48000, 500).crossoverHz).toBe(200);
  });
});
