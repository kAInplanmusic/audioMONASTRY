/**
 * audioMONASTRY · 4.1.4 – Embedding-Cache (pre-computed, WASM-freundlich)
 * ========================================================================
 * Cached Embeddings für bekannte Assets; Berechnung < 50 ms wird durch den
 * Cache auf < 1 ms (Hash-Lookup) gedrückt.
 */
import { storageGetJson, storageSetJson } from '../utils/storage';

export interface CachedEmbedding {
  key: string;
  vector: number[];
  createdAt: number;
}

const MEMORY_CACHE = new Map<string, number[]>();
const STORAGE_KEY = 'audiomonastry_embedding_cache';

/** Liefert ein gecachtes Embedding (Memory zuerst, dann Storage). */
export function getCachedEmbedding(key: string): number[] | null {
  const mem = MEMORY_CACHE.get(key);
  if (mem) return mem;
  const stored = storageGetJson<CachedEmbedding[]>(STORAGE_KEY) ?? [];
  const hit = stored.find((e) => e.key === key);
  if (hit) {
    MEMORY_CACHE.set(key, hit.vector);
    return hit.vector;
  }
  return null;
}

/** Speichert ein Embedding (Memory + Storage, max. 500 Einträge). */
export function cacheEmbedding(key: string, vector: number[]): void {
  MEMORY_CACHE.set(key, vector);
  const stored = storageGetJson<CachedEmbedding[]>(STORAGE_KEY) ?? [];
  const next = [
    { key, vector, createdAt: Date.now() },
    ...stored.filter((e) => e.key !== key),
  ].slice(0, 500);
  storageSetJson(STORAGE_KEY, next);
}

/** Cache-Statistik (Monitoring). */
export function embeddingCacheStats(): { memory: number } {
  return { memory: MEMORY_CACHE.size };
}
