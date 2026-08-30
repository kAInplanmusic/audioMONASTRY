import { describe, expect, it } from 'vitest';
import { random } from '../src/utils/random';

describe('random', () => {
  it('liefert Werte im Intervall [0, 1)', () => {
    for (let i = 0; i < 100; i++) {
      const v = random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('liefert unterschiedliche Werte (nicht deterministisch blockiert)', () => {
    const values = new Set(Array.from({ length: 50 }, () => random()));
    expect(values.size).toBeGreaterThan(1);
  });
});
