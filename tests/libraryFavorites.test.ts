// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { LIBRARY_FAVORITES_KEY, loadFavorites, saveFavorites, toggleFavoriteId } from '../src/utils/libraryFavorites';

describe('biblioMONK Favoriten-Helfer', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('rundet Favoriten über den Storage-Adapter', () => {
    const fav = { samples: ['kick-1', 'hat-2'], music: ['track-9'] };
    saveFavorites(fav);
    expect(loadFavorites()).toEqual(fav);
  });

  it('liefert leere Favoriten, wenn nichts gespeichert ist', () => {
    expect(loadFavorites()).toEqual({ samples: [], music: [] });
  });

  it('toleriert kaputtes JSON (Rückfall leer)', () => {
    localStorage.setItem(LIBRARY_FAVORITES_KEY, '{kaputt');
    expect(loadFavorites()).toEqual({ samples: [], music: [] });
  });

  it('toggleFavoriteId fügt hinzu und entfernt wieder', () => {
    expect(toggleFavoriteId([], 'a')).toEqual(['a']);
    expect(toggleFavoriteId(['a', 'b'], 'a')).toEqual(['b']);
  });
});
