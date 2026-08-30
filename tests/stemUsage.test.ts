import { describe, expect, it, beforeEach } from 'vitest';
import {
  loadStemUsage, recordStemExtraction, estimateStemCost, formatUsd, emptyUsage,
} from '../src/utils/stemUsage';

describe('Stem-Nutzungszähler', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('startet leer', () => {
    expect(emptyUsage()).toEqual({ count: 0, estimatedCostUsd: 0, lastProvider: null, lastAt: null });
  });

  it('schätzt Kosten ehrlich: lokal/stem-ai/fallback = 0, replicate ≈ 0.05 USD', () => {
    expect(estimateStemCost('local')).toBe(0);
    expect(estimateStemCost('stem-ai')).toBe(0);
    expect(estimateStemCost('fallback')).toBe(0);
    expect(estimateStemCost('replicate')).toBe(0.05);
  });

  it('zählt Extraktionen und akkumuliert geschätzte Kosten', () => {
    recordStemExtraction('local', 1000);
    const u1 = recordStemExtraction('replicate', 2000);
    expect(u1.count).toBe(2);
    expect(u1.estimatedCostUsd).toBeCloseTo(0.05);
    expect(u1.lastProvider).toBe('replicate');
    expect(u1.lastAt).toBe(2000);
  });

  it('formatiert USD sauber', () => {
    expect(formatUsd(0.05)).toBe('$0.05');
    expect(formatUsd(2)).toBe('$2.00');
  });

  it('persistiert über loadStemUsage (localStorage)', () => {
    recordStemExtraction('replicate', 1234);
    const loaded = loadStemUsage();
    expect(loaded.count).toBe(1);
    expect(loaded.lastProvider).toBe('replicate');
  });
});
