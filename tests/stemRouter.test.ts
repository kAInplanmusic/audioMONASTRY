import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: { loadTrackSample: vi.fn() },
}));

import { resolveStemChannel, STEM_CHANNEL_MAP } from '../src/utils/StemRouter';

describe('StemRouter (DCT-115)', () => {
  it('mappt die 4-Stem-Demucs-Taxonomie zentral', () => {
    expect(resolveStemChannel('vocals')).toBe('channel5');
    expect(resolveStemChannel('drums')).toBe('channel6');
    expect(resolveStemChannel('bass')).toBe('channel7');
    expect(resolveStemChannel('other')).toBe('channel8');
  });

  it('fällt für unbekannte Stems deterministisch auf channel8 zurück', () => {
    expect(resolveStemChannel('unbekannt')).toBe('channel8');
  });

  it('keine Hardcoded-Mappings außerhalb der zentralen Map', () => {
    expect(Object.keys(STEM_CHANNEL_MAP).length).toBeGreaterThanOrEqual(8);
  });
});
