import { describe, expect, it, vi } from 'vitest';
import {
  SNAPSHOT_SCHEMA_VERSION,
  deserializeEnvelope,
  migrateEnvelope,
  nextEnvelope,
  serializeEnvelope,
} from '../src/core/persistence/snapshotEnvelope';
import {
  DebouncedAutosave,
  SessionAutosave,
  createMemoryStore,
  retryWithBackoff,
} from '../src/core/persistence/sessionAutosave';
import { createBestEffortStore } from '../src/core/persistence/browserStore';

/**
 * PERSIST-P1-002: versioniertes Snapshot-Schema, Migration, debounced Autosave,
 * Retry/Backoff und Idempotenz (gleicher Stand → gleicher Schlüssel bei Retry).
 */
describe('Persistenz – Snapshot-Umschlag & Migration', () => {
  it('hebt einen v1-Stand (ohne Umschlag) auf die aktuelle Version', () => {
    const migrated = migrateEnvelope({ bpm: 128, patterns: { channel1: [true, false] } });
    expect(migrated?.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(migrated?.revision).toBe(0);
    expect(migrated?.idempotencyKey).toBe('rev-0');
    expect(migrated?.payload).toEqual({ bpm: 128, patterns: { channel1: [true, false] } });
  });

  it('akzeptiert einen v1-Umschlag mit payload-Feld', () => {
    const migrated = migrateEnvelope({ schemaVersion: 1, revision: 7, payload: { a: 1 } });
    expect(migrated?.revision).toBe(7);
    expect(migrated?.payload).toEqual({ a: 1 });
  });

  it('lehnt unbekannte/zukünftige Versionen ab, statt zu raten', () => {
    expect(migrateEnvelope({ schemaVersion: 99, payload: {} })).toBeNull();
    expect(migrateEnvelope(null)).toBeNull();
    expect(migrateEnvelope({ schemaVersion: 2 })).toBeNull(); // kein payload
    expect(deserializeEnvelope('kein json')).toBeNull();
  });

  it('erhöht die Revision monoton und bildet je Stand einen stabilen Schlüssel', () => {
    const first = nextEnvelope({ a: 1 }, { savedAt: 1000 });
    const second = nextEnvelope({ a: 2 }, { previous: first, savedAt: 2000 });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(deserializeEnvelope(serializeEnvelope(second))?.payload).toEqual({ a: 2 });
  });
});

describe('Persistenz – Debounce & Flush', () => {
  it('fasst schnelle Änderungen zu EINEM Schreibvorgang zusammen', async () => {
    vi.useFakeTimers();
    try {
      const saved: unknown[] = [];
      const autosave = new DebouncedAutosave<number>(async (v) => { saved.push(v); }, { delayMs: 500 });
      autosave.schedule(1);
      autosave.schedule(2);
      autosave.schedule(3);
      expect(autosave.pending).toBe(true);
      expect(saved).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(saved).toEqual([3]); // nur der letzte Stand
      expect(autosave.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush() schreibt sofort, ohne auf den Timer zu warten', async () => {
    vi.useFakeTimers();
    try {
      const saved: number[] = [];
      const autosave = new DebouncedAutosave<number>(async (v) => { saved.push(v); }, { delayMs: 5_000 });
      autosave.schedule(42);
      await autosave.flush();
      expect(saved).toEqual([42]);
      expect(autosave.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Persistenz – Retry/Backoff', () => {
  it('wiederholt mit exponentiellem Backoff und gedeckelter Wartezeit', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts += 1;
        if (attempts < 4) throw new Error(`fail ${attempts}`);
        return 'ok';
      },
      { attempts: 5, baseDelayMs: 100, maxDelayMs: 250, sleep: async (ms) => { delays.push(ms); } },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(4);
    expect(delays).toEqual([100, 200, 250]); // 100, 200, dann gedeckelt auf 250
  });

  it('reicht den letzten Fehler nach Ausschöpfen der Versuche weiter', async () => {
    await expect(retryWithBackoff(async () => { throw new Error('dauerhaft'); }, { attempts: 2, sleep: async () => {} }))
      .rejects.toThrow('dauerhaft');
  });
});

describe('Persistenz – SessionAutosave (Idempotenz + Revision)', () => {
  it('nutzt bei Retries denselben idempotencyKey (keine neue Revision)', async () => {
    const store = createMemoryStore();
    const seen: string[] = [];
    let calls = 0;
    const flaky = {
      ...store,
      async set(key: string, value: string) {
        calls += 1;
        seen.push(JSON.parse(value).idempotencyKey as string);
        if (calls < 3) throw new Error('storage down');
        await store.set(key, value);
      },
    };
    const autosave = new SessionAutosave(flaky, { now: () => 5_000, retry: { attempts: 3, baseDelayMs: 0, sleep: async () => {} } });
    const envelope = await autosave.saveNow({ bpm: 128 });

    expect(calls).toBe(3);
    expect(new Set(seen).size).toBe(1); // exakt EIN Schlüssel über alle Versuche
    expect(seen[0]).toBe(envelope.idempotencyKey);
    expect(envelope.revision).toBe(1);
  });

  it('setzt die Revision nach einem Reload fort (load → nächste Revision)', async () => {
    const store = createMemoryStore();
    const first = new SessionAutosave(store, { now: () => 1_000 });
    await first.saveNow({ bpm: 120 });
    await first.saveNow({ bpm: 124 });

    const reloaded = new SessionAutosave(store, { now: () => 2_000 });
    const loaded = await reloaded.load();
    expect(loaded?.revision).toBe(2);
    expect(loaded?.payload).toEqual({ bpm: 124 });

    const next = await reloaded.saveNow({ bpm: 130 });
    expect(next.revision).toBe(3);
  });

  it('debounced schedule + flush schreibt genau den letzten Stand', async () => {
    const store = createMemoryStore();
    const autosave = new SessionAutosave(store, { now: () => 7_000, delayMs: 0 });
    autosave.schedule({ bpm: 100 });
    autosave.schedule({ bpm: 140 });
    await autosave.flush();
    const loaded = await new SessionAutosave(store).load();
    expect(loaded?.payload).toEqual({ bpm: 140 });
    expect(loaded?.revision).toBe(1);
  });

  it('createBestEffortStore liefert ohne IndexedDB ehrlich einen Memory-Store', () => {
    const original = (globalThis as { indexedDB?: unknown }).indexedDB;
    try {
      // jsdom/Node in dieser Suite hat kein IndexedDB → ehrlicher Fallback.
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
      const best = createBestEffortStore();
      expect(best.kind).toBe('memory');
      expect(typeof best.store.get).toBe('function');
    } finally {
      if (original !== undefined) (globalThis as { indexedDB?: unknown }).indexedDB = original;
    }
  });
});
