/**
 * biblioMONK Favoriten – reine Persistenz-/Filter-Helfer (keine Audio-Abhängigkeit).
 * Bewusst getrennt von LibraryTerminal, damit Unit-Tests ohne AudioEngine laufen.
 */
import { storageGetJson, storageSetJson } from './storage';

export const LIBRARY_FAVORITES_KEY = 'audiomonastry_library_favorites';

export interface FavoritesState {
  samples: string[];
  music: string[];
}

export function loadFavorites(): FavoritesState {
  const raw = storageGetJson<Partial<FavoritesState>>(LIBRARY_FAVORITES_KEY);
  // Form-Guard (E2E-2026-10-20-001): Im Studio-Store lag das ALTE Format
  // ({ids:["alt-1"]}, Stand vor dem Samples/Music-Split) - es ueberlebt in
  // data/state/session-state.json Server-Neustarts. Ohne Guard war
  // favorites.samples undefined und das RENDERN der Bibliothek crashte
  // (SafeModuleBoundary 'Modul-Fehler'), fuer jeden Nutzer, solange der
  // Gift-Eintrag lag. Fail-closed: ungültige Form -> leerer Stand; der
  // naechste saveFavorites (useEffect im Terminal) ueberschreibt das alte
  // Format sofort mit dem aktuellen.
  if (!raw || !Array.isArray(raw.samples) || !Array.isArray(raw.music)) {
    return { samples: [], music: [] };
  }
  return { samples: raw.samples, music: raw.music };
}

export function saveFavorites(favorites: FavoritesState): void {
  storageSetJson(LIBRARY_FAVORITES_KEY, favorites);
}

/** Fügt eine ID hinzu bzw. entfernt sie (Toggle). */
export function toggleFavoriteId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
