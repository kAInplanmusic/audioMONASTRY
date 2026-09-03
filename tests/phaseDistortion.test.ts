import { describe, expect, it } from 'vitest';
import { czPhaseDistortion } from '../src/core/instrument/phaseDistortion';

describe('Phase-Distortion-Oszillator (Casio-CZ-Prinzip)', () => {
  it('amount 0 ergibt einen reinen Cosinus (Sinus-Verwandten)', () => {
    for (const p of [0, 0.25, 0.5, 0.75]) {
      expect(Math.abs(czPhaseDistortion(p, 0) - Math.cos(2 * Math.PI * p))).toBeLessThan(1e-9);
    }
  });

  it('amount > 0 verändert die Wellenform messbar', () => {
    let diff = 0;
    for (let i = 0; i < 64; i++) {
      const p = i / 64;
      diff += Math.abs(czPhaseDistortion(p, 0.25) - czPhaseDistortion(p, 0));
    }
    expect(diff).toBeGreaterThan(0.1);
  });

  it('ist deterministisch, geclampt und endlich', () => {
    for (const p of [-0.5, 0, 0.3, 1, 1.5]) {
      const a = czPhaseDistortion(p, 0.7);
      const b = czPhaseDistortion(p, 0.7);
      expect(a).toBe(b);
      expect(Number.isFinite(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(-1);
      expect(a).toBeLessThanOrEqual(1);
    }
  });
});
