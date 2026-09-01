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
  return storageGetJson<FavoritesState>(LIBRARY_FAVORITES_KEY) ?? { samples: [], music: [] };
}

export function saveFavorites(favorites: FavoritesState): void {
  storageSetJson(LIBRARY_FAVORITES_KEY, favorites);
}

/** Fügt eine ID hinzu bzw. entfernt sie (Toggle). */
export function toggleFavoriteId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
