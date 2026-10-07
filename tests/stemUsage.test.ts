import { describe, expect, it, beforeEach } from 'vitest';
import { resetStorageForTests } from '../src/utils/storage';
import {
  loadStemUsage, recordStemExtraction, estimateStemCost, formatUsd, emptyUsage,
} from '../src/utils/stemUsage';

describe('Stem-Nutzungszähler', () => {
  beforeEach(() => {
    resetStorageForTests();
  });

  it('startet leer', () => {
    expect(emptyUsage()).toEqual({ count: 0, estimatedCostUsd: 0, lastProvider: null, lastAt: null });
  });

  it('alle verbliebenen Wege laufen auf eigener Hardware: Kosten 0 (RT-AUDIT-P1-014, Replicate entfernt)', () => {
    expect(estimateStemCost('local')).toBe(0);
    expect(estimateStemCost('stem-ai')).toBe(0);
    expect(estimateStemCost('fallback')).toBe(0);
  });

  it('zählt Extraktionen und merkt sich den letzten Provider', () => {
    recordStemExtraction('local', 1000);
    const u1 = recordStemExtraction('stem-ai', 2000);
    expect(u1.count).toBe(2);
    expect(u1.estimatedCostUsd).toBe(0);
    expect(u1.lastProvider).toBe('stem-ai');
    expect(u1.lastAt).toBe(2000);
  });

  it('formatiert USD sauber', () => {
    expect(formatUsd(0.05)).toBe('$0.05');
    expect(formatUsd(2)).toBe('$2.00');
  });

  it('persistiert über loadStemUsage (Studio-Speicher, nicht auf dem Gerät)', () => {
    recordStemExtraction('stem-ai', 1234);
    const loaded = loadStemUsage();
    expect(loaded.count).toBe(1);
    expect(loaded.lastProvider).toBe('stem-ai');
  });
});
