/**
 * audioMONASTRY · Drop-Cache (AI-P2-006)
 * ======================================
 * Warum: `POST /api/ai/generate-drop` lief nur durch den globalen
 * `expensiveLimiter`. Zwei identische Anfragen (gleicher Prompt, gleicher
 * Kontext, gleiches Profil) kosteten jedes Mal einen bezahlten Modellaufruf -
 * bei GPU-Wakes doppelt teuer, weil schon der Wake Geld kostet. Der Cache
 * sitzt VOR dem Modellaufruf und ist bewusst konservativ:
 *
 *   - nur echte Modell-Ergebnisse werden gespeichert (LLM/Ollama). Der lokale
 *     deterministische Fallback ist gratis und wird nicht gecacht - sonst
 *     verdeckt ein Cache-Treffer, dass gerade gar kein Modell antwortet.
 *   - kurze Lebensdauer (`ttlMs`, Default 10 min) und harte Obergrenze
 *     (`maxEntries`, Default 50): der Speicher waechst nicht mit der Nutzung.
 *   - der Schluessel traegt eine Version (`keyVersion`); aendert sich die
 *     Prompt- oder Antwortform, wird der Cache durch Hochzaehlen ungueltig,
 *     statt alte Antworten weiterzureichen.
 *   - rein und ohne Netz: die Zeit kommt herein (`nowMs`), damit TTL und
 *     Verdrängung ohne Warten testbar sind.
 *
 * Der Treffer wird in der Antwort sichtbar (`cached: true`) und in den Metriken
 * gezaehlt (`aiCacheHits`/`aiCacheMisses`, Prometheus + JSON).
 */

/** Eingangswerte, die eine Antwort bestimmen (alles andere ist nicht im Key). */
export interface DropCacheInput {
  userPrompt: string;
  /** Alle weiteren Felder sind optional, damit der Aufrufer seinen Request-Typ
   *  (DropGenerationRequest) direkt uebergeben kann - die Normalisierung macht
   *  der Schluessel. */
  bpm?: number;
  currentEnergy?: number;
  activePlugins?: string[];
  style?: string;
  duration?: number;
}

export interface DropCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Hochzaehlen, wenn sich Prompt-/Antwortform aendert (invalidiert alte Treffer). */
  keyVersion?: string;
  now?: () => number;
}

export interface DropCacheStats {
  hits: number;
  misses: number;
  stored: number;
  evicted: number;
  expired: number;
  entries: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 50;

/**
 * Stabiler Schluessel: Plugin-Reihenfolge und Zahlenformat duerfen keine
 * unterschiedlichen Keys erzeugen (sonst ist der Cache zufaellig leer).
 */
export function dropCacheKey(input: DropCacheInput, keyVersion = 'v1'): string {
  const plugins = [...(input.activePlugins ?? [])].map((p) => String(p)).sort();
  // Zahlen normalisieren: 128 und 128.0 sollen denselben Schluessel ergeben,
  // fehlende Werte einen stabilen Default haben (sonst ist der Cache zufaellig leer).
  const bpm = Number(input.bpm ?? 128);
  const energy = Number(input.currentEnergy ?? 0.5);
  return JSON.stringify({
    v: keyVersion,
    prompt: (input.userPrompt ?? '').trim(),
    bpm: Number.isFinite(bpm) ? Number(bpm.toFixed(3)) : 128,
    energy: Number.isFinite(energy) ? Number(energy.toFixed(3)) : 0.5,
    plugins,
    style: input.style ?? 'moderate',
    duration: input.duration ?? null,
  });
}

export function createDropCache(options: DropCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const keyVersion = options.keyVersion ?? 'v1';
  const now = options.now ?? (() => Date.now());

  const store = new Map<string, { value: unknown; storedAt: number }>();
  const stats = { hits: 0, misses: 0, stored: 0, evicted: 0, expired: 0 };

  function get<T = Record<string, unknown>>(key: string): T | null {
    const entry = store.get(key);
    if (!entry) {
      stats.misses += 1;
      return null;
    }
    if (now() - entry.storedAt >= ttlMs) {
      store.delete(key);
      stats.expired += 1;
      stats.misses += 1;
      return null;
    }
    stats.hits += 1;
    return entry.value as T;
  }

  function set(key: string, value: unknown): void {
    if (store.has(key)) store.delete(key);
    store.set(key, { value, storedAt: now() });
    stats.stored += 1;
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      store.delete(oldest);
      stats.evicted += 1;
    }
  }

  function statsSnapshot(): DropCacheStats {
    return { ...stats, entries: store.size };
  }

  function clear(): void {
    store.clear();
  }

  return {
    key: (input: DropCacheInput) => dropCacheKey(input, keyVersion),
    get,
    set,
    stats: statsSnapshot,
    clear,
    ttlMs,
    maxEntries,
  };
}

export type DropCache = ReturnType<typeof createDropCache>;

/** Prozessweiter Cache der Route (eine Instanz pro Serverprozess). */
export const dropCache: DropCache = createDropCache();
