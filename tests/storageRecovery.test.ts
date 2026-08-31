import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  storageGet, storageGetJson, storageSet, storageSetJson,
} from '../src/utils/storage';
import {
  largeDelete, largeGetJson, largeSetJson, openDB, saveToDB,
} from '../src/utils/indexedDB';

/**
 * Storage-Recovery (RELEASE_GATE.md):
 * Korruptes localStorage/IndexedDB darf die App nie crashen – Adapter
 * müssen sich selbst heilen (null liefern, No-Op) und überschreibbar bleiben.
 */
describe('Storage-Recovery – localStorage', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it('liefert bei korruptem JSON null und erholt sich durch Überschreiben', () => {
    storageSet('corrupt', '{"half":');
    expect(storageGet('corrupt')).toBe('{"half":');
    expect(storageGetJson('corrupt')).toBeNull(); // Recovery: kein Crash

    storageSetJson('corrupt', { ok: true });
    expect(storageGetJson('corrupt')).toEqual({ ok: true });
  });

  it('wirft nicht bei Quota-/Security-Fehlern von setItem/getItem', () => {
    const originalSet = globalThis.localStorage!.setItem;
    const originalGet = globalThis.localStorage!.getItem;
    const boom = () => { throw new DOMException('Quota', 'QuotaExceededError'); };

    globalThis.localStorage!.setItem = vi.fn(boom);
    globalThis.localStorage!.getItem = vi.fn(boom);

    expect(() => storageSet('x', 'y')).not.toThrow();
    expect(storageGet('x')).toBeNull();
    expect(storageGetJson('x')).toBeNull();

    globalThis.localStorage!.setItem = originalSet;
    globalThis.localStorage!.getItem = originalGet;
  });
});

describe('Storage-Recovery – IndexedDB ohne Umgebungs-API', () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it('openDB lehnt sauber ab statt synchron zu werfen', async () => {
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
    await expect(openDB()).rejects.toThrow('IndexedDB nicht verfügbar');
  });

  it('saveToDB/largeGetJson/largeSetJson/largeDelete sind No-Ops', async () => {
    await expect(saveToDB({ id: 'x' })).resolves.toBeUndefined();
    await expect(largeGetJson('k')).resolves.toBeNull();
    await expect(largeSetJson('k', { v: 1 })).resolves.toBeUndefined();
    await expect(largeDelete('k')).resolves.toBeUndefined();
  });
});

describe('Storage-Recovery – IndexedDB öffnen mit Retry', () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  it('setzt den Verbindungs-Cache nach Fehler zurück (Retry möglich)', async () => {
    vi.resetModules();
    (globalThis as { indexedDB?: unknown }).indexedDB = makeFakeIndexedDB(['fail', 'ok']);

    const mod = await import('../src/utils/indexedDB');
    await expect(mod.openDB()).rejects.toThrow('blocked');
    // Nach dem Fehler muss ein zweiter Versuch eine frische Verbindung öffnen.
    await expect(mod.openDB()).resolves.toMatchObject({ fake: true });
  });
});

/** Minimaler IndexedDB-Fake: `open()` liefert Request-Objekte mit Setter-Semantik. */
function makeFakeIndexedDB(behavior: Array<'fail' | 'ok'>) {
  let call = 0;
  return {
    open: () => {
      const mode = behavior[Math.min(call++, behavior.length - 1)];
      const req: {
        result: {
          objectStoreNames: { contains: (n: string) => boolean };
          createObjectStore: (n: string) => object;
          fake: boolean;
        };
        error: Error;
      } = {
        result: {
          objectStoreNames: { contains: () => false },
          createObjectStore: () => ({}),
          fake: true,
        },
        error: new Error('blocked'),
      };
      let onerror: ((err: Error) => void) | null = null;
      let onsuccess: (() => void) | null = null;
      Object.defineProperty(req, 'onupgradeneeded', {
        set(fn: () => void) { if (mode === 'ok') fn(); },
      });
      Object.defineProperty(req, 'onsuccess', {
        set(fn: () => void) { onsuccess = fn; },
      });
      Object.defineProperty(req, 'onerror', {
        set(fn: (err: Error) => void) { onerror = fn; },
      });
      queueMicrotask(() => {
        if (mode === 'fail') onerror?.(req.error);
        else onsuccess?.();
      });
      return req;
    },
  };
}
