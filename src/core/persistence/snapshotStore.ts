/**
 * audioMONASTRY · Persistenz – SnapshotStore (P1-2)
 * ================================================================
 * Automatische, versionierte Snapshots mit Integritätsprüfung,
 * Retention und trockenem Cleanup.
 *
 * Regeln:
 *   - Jeder Snapshot erhält `savedAt`, `revision` und eine `checksum`
 *     (über die serialisierte Payload).
 *   - `restore()` prüft die Checksumme, bevor die Payload zurückgegeben wird.
 *   - `prune()` behält den NEUESTEN gültigen Snapshot IMMER (auch wenn er die
 *     Limits überschreitet) und löscht nur ältere, die `maxSnapshots` oder
 *     `maxAgeMs` überschreiten.
 *   - `prune({ dryRun: true })` liefert nur die Löschliste, ohne zu löschen.
 *   - `write()` serialisiert atomar über den injizierten Key-Value-Store
 *     (der Store-Adapter garantiert atomisches `set`; z. B. Redis SET oder
 *     In-Memory-Map).
 *
 * Bewusst rein: kein I/O, kein `node:crypto`, keine Timer. Checksumme und
 * Zeitquelle werden injiziert (Default: FNV-1a 32-bit für Tests/Browser,
 * Server verdrahtet SHA-256).
 */

export interface SnapshotRecord<T = unknown> {
  id: string;
  savedAt: number;
  revision: number;
  /** Hex-String der Prüfsumme über `payloadJson`. */
  checksum: string;
  /** Serialisierte Payload (JSON). */
  payloadJson: string;
  payload?: T;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<void> | void;
  remove(key: string): Promise<void> | void;
  keys(): Promise<string[]> | string[];
}

export interface SnapshotStoreOptions {
  /** Maximale Anzahl behaltener Snapshots (neuester zählt immer). */
  maxSnapshots?: number;
  /** Maximales Alter in ms (ältere werden entfernt, neuester nie). */
  maxAgeMs?: number;
  /** Zeitquelle (injizierbar für Tests). */
  now?: () => number;
  /** Prüfsummen-Funktion (injizierbar, z. B. SHA-256). */
  checksum?: (input: string) => string;
}

/** Kompakter 32-bit FNV-1a (Fallback; kein kryptografischer Schutz). */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function defaultSnapshotId(now: number, revision: number): string {
  return `${now.toString(36)}-${revision.toString(36)}`;
}

export class SnapshotStore<T = unknown> {
  private readonly maxSnapshots: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly checksum: (input: string) => string;

  constructor(
    private readonly store: KeyValueStore,
    options: SnapshotStoreOptions = {},
  ) {
    this.maxSnapshots = Math.max(1, Math.floor(options.maxSnapshots ?? 20));
    this.maxAgeMs = Math.max(0, Math.floor(options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000));
    this.now = options.now ?? Date.now;
    this.checksum = options.checksum ?? fnv1aHex;
  }

  private key(id: string): string {
    return `snapshot:${id}`;
  }

  /** Serialisiert einen Snapshot-Datensatz (ohne payload-Objekt). */
  private encode(record: Omit<SnapshotRecord<T>, 'payload'>): string {
    return JSON.stringify(record);
  }

  private decode(raw: string): SnapshotRecord<T> | null {
    try {
      const parsed = JSON.parse(raw) as SnapshotRecord<T>;
      if (
        !parsed
        || typeof parsed.id !== 'string'
        || typeof parsed.checksum !== 'string'
        || typeof parsed.payloadJson !== 'string'
        || typeof parsed.savedAt !== 'number'
        || typeof parsed.revision !== 'number'
      ) return null;
      parsed.payload = JSON.parse(parsed.payloadJson) as T;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Schreibt einen neuen Snapshot (atomar über den Store-Adapter). */
  async write(payload: T, revision?: number): Promise<SnapshotRecord<T>> {
    const savedAt = this.now();
    const rev = Number.isFinite(revision as number | undefined) ? (revision as number) : savedAt;
    const payloadJson = JSON.stringify(payload ?? null);
    const record: SnapshotRecord<T> = {
      id: defaultSnapshotId(savedAt, rev),
      savedAt,
      revision: rev,
      checksum: this.checksum(payloadJson),
      payloadJson,
    };
    await this.store.set(this.key(record.id), this.encode(record));
    return record;
  }

  /** Alle Snapshots, neueste zuerst (defensiv: kaputte Einträge werden ignoriert). */
  async list(): Promise<SnapshotRecord<T>[]> {
    const keys = await this.store.keys();
    const records: SnapshotRecord<T>[] = [];
    for (const key of keys) {
      if (!key.startsWith('snapshot:')) continue;
      const raw = await this.store.get(key);
      if (!raw) continue;
      const record = this.decode(raw);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.savedAt - a.savedAt || b.revision - a.revision);
  }

  /** Neuester Snapshot mit gültiger Checksumme (oder null). */
  async latestValid(): Promise<SnapshotRecord<T> | null> {
    const records = await this.list();
    for (const record of records) {
      if (record.checksum === this.checksum(record.payloadJson)) return record;
    }
    return null;
  }

  /**
   * Stellt einen Snapshot wieder her (Checksummen-geprüft).
   * `id` kann eine exakte ID oder 'latest' für den neuesten gültigen sein.
   */
  async restore(id: string): Promise<SnapshotRecord<T> | null> {
    if (id === 'latest') return this.latestValid();
    const raw = await this.store.get(this.key(id));
    if (!raw) return null;
    const record = this.decode(raw);
    if (!record || record.checksum !== this.checksum(record.payloadJson)) return null;
    return record;
  }

  /**
   * Retention: entfernt alte Snapshots außerhalb `maxSnapshots`/`maxAgeMs`.
   * Der neueste gültige Snapshot wird NIE gelöscht. `dryRun` liefert nur die
   * Löschliste (kein Store-Zugriff außer Lesen).
   */
  async prune(options: { now?: number; dryRun?: boolean } = {}): Promise<{ deleted: string[]; kept: string[] }> {
    const t = options.now ?? this.now();
    const records = await this.list();
    const latest = records.find((r) => r.checksum === this.checksum(r.payloadJson)) ?? records[0];
    const newestId = latest?.id ?? '';
    const kept = new Set<string>();
    const deleted: string[] = [];
    let keptCount = 0;

    for (const record of records) {
      const isNewest = record.id === newestId;
      const tooOld = this.maxAgeMs > 0 && t - record.savedAt > this.maxAgeMs;
      const overLimit = keptCount >= this.maxSnapshots;

      if (!isNewest && (tooOld || overLimit)) {
        deleted.push(record.id);
        continue;
      }
      kept.add(record.id);
      keptCount += 1;
    }

    if (!options.dryRun) {
      for (const id of deleted) {
        await this.store.remove(this.key(id));
      }
    }
    return { deleted, kept: [...kept] };
  }
}

/** In-Memory-Store für Tests und Browser-Fallback. */
export function createMemoryKeyValueStore(seed: Record<string, string> = {}): KeyValueStore {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get(key) { return map.get(key) ?? null; },
    set(key, value) { map.set(key, value); },
    remove(key) { map.delete(key); },
    keys() { return [...map.keys()]; },
  };
}
