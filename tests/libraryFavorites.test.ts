// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { resetStorageForTests, storageSet } from '../src/utils/storage';
import { LIBRARY_FAVORITES_KEY, loadFavorites, saveFavorites, toggleFavoriteId } from '../src/utils/libraryFavorites';

describe('biblioMONK Favoriten-Helfer', () => {
  beforeEach(() => {
    resetStorageForTests();
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
    storageSet(LIBRARY_FAVORITES_KEY, '{kaputt');
    expect(loadFavorites()).toEqual({ samples: [], music: [] });
  });

  it('E2E-2026-10-20-001: altes Favoriten-Format ({ids}) crasht das Rendern nicht mehr', () => {
    // Gemessen im Fehllauf: Im Studio-Store lag das VOR-dem-Split-Format
    // ({ids:["alt-1"]}) - es überlebt Server-Neustarts (fileSessionPersistence)
    // und machte favorites.samples zu undefined -> SafeModuleBoundary
    // 'Modul-Fehler' beim Rendern der Bibliothek. Jetzt: Form-Guard, fail-closed.
    storageSet(LIBRARY_FAVORITES_KEY, JSON.stringify({ ids: ['alt-1'] }));
    expect(loadFavorites()).toEqual({ samples: [], music: [] });
    // Teilobjekt (nur samples) fällt ebenso sauber zurück.
    storageSet(LIBRARY_FAVORITES_KEY, JSON.stringify({ samples: ['kick-1'] }));
    expect(loadFavorites()).toEqual({ samples: [], music: [] });
    // Und ein gültiger Stand bleibt erhalten.
    storageSet(LIBRARY_FAVORITES_KEY, JSON.stringify({ samples: ['kick-1'], music: ['track-9'] }));
    expect(loadFavorites()).toEqual({ samples: ['kick-1'], music: ['track-9'] });
  });

  it('toggleFavoriteId fügt hinzu und entfernt wieder', () => {
    expect(toggleFavoriteId([], 'a')).toEqual(['a']);
    expect(toggleFavoriteId(['a', 'b'], 'a')).toEqual(['b']);
  });
});
