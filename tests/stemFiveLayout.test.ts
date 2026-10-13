import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIVE_STEMS, fiveStemLibraryEntries } from '../src/plugins/adapters/StemPluginAdapter';

/**
 * FLEET-P1-006 / AGENTS.md #11: stemMONK zeigt fünf Stems (Vocals, Lows, Mids,
 * Highs, Melodie) und legt sie still in der Bibliothek ab. Reihenfolge = Python
 * `stem_crossover.FIVE_STEM_KEYS` (RP5-Handler).
 */
const crossoverPy = readFileSync(
  fileURLToPath(new URL('../services/audiomonastry-ai-runtime/stem_crossover.py', import.meta.url)),
  'utf8',
);

describe('stemMONK: fünf Stems', () => {
  it('Reihenfolge und Anzeige nach Spezifikation, gespiegelt zum RP5-Handler', () => {
    expect(FIVE_STEMS.map((s) => s.key)).toEqual(['vocals', 'lows', 'mids', 'highs', 'melody']);
    expect(FIVE_STEMS.map((s) => s.label)).toEqual(['Vocals', 'Lows', 'Mids', 'Highs', 'Melodie']);
    expect(crossoverPy).toContain('FIVE_STEM_KEYS = ("vocals", "lows", "mids", "highs", "melody")');
  });

  it('legt jeden gelieferten Stem mit Kategorie in der Bibliothek ab', () => {
    const urls = { vocals: 'u/v', lows: 'u/l', mids: 'u/m', highs: 'u/h', melody: 'u/me' };
    const entries = fiveStemLibraryEntries('Song.Final.wav', { stems: urls, melodyAvailable: true });
    expect(entries.map((e) => e.key)).toEqual(['vocals', 'lows', 'mids', 'highs', 'melody']);
    expect(entries.map((e) => e.category)).toEqual(['mids', 'bass', 'mids', 'highs', 'mids']);
    expect(entries[1]).toMatchObject({ name: 'Song.Final_lows', url: 'u/l' });
    expect(entries.every((e) => !e.description.includes('Fallback'))).toBe(true);
  });

  it('4-Stem-Fallback: leere Melodie landet nicht in der Bibliothek und ist gekennzeichnet', () => {
    const entries = fiveStemLibraryEntries('a.mp3', {
      stems: { vocals: 'v', lows: 'l', mids: 'm', highs: 'h', melody: '' },
      melodyAvailable: false,
    });
    expect(entries.map((e) => e.key)).toEqual(['vocals', 'lows', 'mids', 'highs']);
    expect(entries.every((e) => e.description.includes('4-Stem-Fallback'))).toBe(true);
  });

  it('ohne URLs nichts ablegen (kein Schein-Ergebnis)', () => {
    expect(fiveStemLibraryEntries('x.wav', { stems: {} })).toEqual([]);
  });
});
