/**
 * audioMONASTRY · Persistenz – Redis-Key-Value-Adapter (PERSIST-P1-003)
 * =====================================================================
 * Der `SnapshotStore` (src/core/persistence/snapshotStore.ts) ist bewusst rein
 * und schreibt über die schmale `KeyValueStore`-Schnittstelle. Bisher wurde ihm
 * immer `createMemoryKeyValueStore()` gegeben - Snapshots lagen damit **nur im
 * Prozess**: ein Neustart (oder eine zweite App-Instanz im Multi-Instanz-Modus)
 * verlor sie, obwohl die Retention-/Checksummen-Mechanik genau dafür gedacht ist.
 *
 * Dieses Modul liefert den fehlenden Adapter: `createRedisKeyValueStore()` legt
 * denselben Vertrag auf einen Redis-Client (die App nutzt `redis` bereits für
 * den Socket.io-Adapter und die Session-Persistenz).
 *
 * Vertragstreue Details, die den Store nicht kaputt machen dürfen:
 *   * `keys()` liefert die Schlüssel **ohne** Präfix - der SnapshotStore filtert
 *     selbst auf `snapshot:` und würde sonst nichts mehr finden.
 *   * Fremde Schlüssel unter demselben Präfix werden nie zurückgegeben, wenn sie
 *     nicht mit dem Präfix beginnen (defensiv, falls der Client fuzzy matcht).
 *   * Werte werden 1:1 als String durchgereicht (die Serialisierung macht der
 *     SnapshotStore; hier wird nicht interpretiert).
 *
 * Bewusst frei von `redis`-Imports: der Client wird als Interface erwartet
 * (`RedisLikeClient`), dadurch ist der Adapter ohne Redis testbar und die
 * Abhängigkeit bleibt an der Aufrufstelle.
 */
import type { KeyValueStore } from './snapshotStore';

/**
 * Der Ausschnitt der Redis-API, den der Adapter braucht.
 *
 * Rueckgaben sind bewusst `unknown`: node-redis v6 typisiert `get()` als
 * `string | {}` (wegen der generischen Client-Parameter) und die anderen
 * Methoden ebenfalls unspezifisch. Der Adapter prueft die Typen selbst - so
 * passt sowohl node-redis als auch ein Test-Double ohne Cast hinein.
 */
export interface RedisLikeClient {
  get(key: string): Promise<unknown> | unknown;
  set(key: string, value: string): Promise<unknown> | unknown;
  del(...keys: string[]): Promise<unknown> | unknown;
  keys(pattern: string): Promise<unknown> | unknown;
}

export const DEFAULT_REDIS_KV_PREFIX = 'audiomonastry:kv:';

export interface RedisKeyValueStoreOptions {
  /**
   * Präfix für alle Schlüssel (Default `audiomonastry:kv:`). Ein leeres Präfix
   * ist erlaubt, gibt aber `keys()` alle Schlüssel der Datenbank zurück - nur
   * für eine dedizierte Redis-DB sinnvoll.
   */
  prefix?: string;
}

/** Normalisiert das Präfix (fügt den Doppelpunkt an, falls er fehlt). */
export function normalizeRedisKvPrefix(prefix?: string): string {
  const raw = prefix ?? DEFAULT_REDIS_KV_PREFIX;
  if (raw === '') return '';
  return raw.endsWith(':') ? raw : `${raw}:`;
}

/**
 * `KeyValueStore` auf Basis eines Redis-Clients.
 * Jeder Aufruf ist eigenständig; es gibt keinen In-Memory-Zwischenspeicher -
 * sonst wäre der Sinn (Überleben eines Prozess-Neustarts) wieder verfehlt.
 */
export function createRedisKeyValueStore(
  client: RedisLikeClient,
  options: RedisKeyValueStoreOptions = {},
): KeyValueStore {
  const prefix = normalizeRedisKvPrefix(options.prefix);
  return {
    async get(key: string): Promise<string | null> {
      const value = await client.get(`${prefix}${key}`);
      return typeof value === 'string' ? value : null;
    },
    async set(key: string, value: string): Promise<void> {
      await client.set(`${prefix}${key}`, value);
    },
    async remove(key: string): Promise<void> {
      await client.del(`${prefix}${key}`);
    },
    async keys(): Promise<string[]> {
      const found = await client.keys(`${prefix}*`);
      if (!Array.isArray(found)) return [];
      return found
        .filter((key): key is string => typeof key === 'string' && key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    },
  };
}
