// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';

// DeckSkins importiert die AudioEngine nur für Trigger-Aufrufe; im Test mocken.
vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: {
    triggerEvent: () => {},
    loadTrackSample: () => {},
    previewSample: () => {},
  },
}));

import { DECK_SKIN_STORAGE_KEY, loadDeckSkins, saveDeckSkins } from '../src/components/mixer/DeckSkins';

describe('mixerMONK Deck-Skins', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('liefert Defaults A=TURNTABLE(CDJ) / B=PAD(DJS) ohne Persistenz', () => {
    const skins = loadDeckSkins();
    expect(skins.A).toBe('TURNTABLE');
    expect(skins.B).toBe('PAD');
  });

  it('persistiert und lädt die Auswahl pro Deck', () => {
    saveDeckSkins({ A: 'PAD', B: 'TURNTABLE' });
    expect(loadDeckSkins()).toEqual({ A: 'PAD', B: 'TURNTABLE' });
    expect(localStorage.getItem(DECK_SKIN_STORAGE_KEY)).toContain('PAD');
  });

  it('fällt bei ungültigem JSON auf Defaults zurück', () => {
    localStorage.setItem(DECK_SKIN_STORAGE_KEY, '{kaputt');
    expect(loadDeckSkins()).toEqual({ A: 'TURNTABLE', B: 'PAD' });
  });

  it('ignoriert ungültige Skin-IDs und nutzt Defaults', () => {
    localStorage.setItem(DECK_SKIN_STORAGE_KEY, JSON.stringify({ A: 'KAPUTT', B: 'TURNTABLE' }));
    expect(loadDeckSkins()).toEqual({ A: 'TURNTABLE', B: 'PAD' });
  });
});
