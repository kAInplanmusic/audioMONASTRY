import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  storageGet, storageGetJson, storageSet, storageSetJson,
} from '../src/utils/storage';
import {
  largeDelete, largeGetJson, largeSetJson,
} from '../src/utils/indexedDB';
import { resetStorageForTests } from '../src/utils/storage';

/**
 * Storage-Recovery (Release-Gate, MASTERTODOENDE.json):
 * Korruptes localStorage/IndexedDB darf die App nie crashen – Adapter
 * müssen sich selbst heilen (null liefern, No-Op) und überschreibbar bleiben.
 */
describe('Storage-Recovery – Adapter ohne Gerätespeicher', () => {
  beforeEach(() => {
    resetStorageForTests();
  });

  it('liefert bei korruptem JSON null und erholt sich durch Überschreiben', () => {
    storageSet('corrupt', '{"half":');
    expect(storageGet('corrupt')).toBe('{"half":');
    expect(storageGetJson('corrupt')).toBeNull(); // Recovery: kein Crash

    storageSetJson('corrupt', { ok: true });
    expect(storageGetJson('corrupt')).toEqual({ ok: true });
  });

  it('berührt den Browser-Speicher nicht (Betreiber 2026-10-06: nichts auf den Geräten)', () => {
    const setSpy = vi.spyOn(globalThis.localStorage ?? { setItem: () => undefined }, 'setItem');
    storageSet('audiomonastry_local_presets', '[]');
    storageSetJson('moa-log-eq', ['x']);
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });
});


describe('Storage-Recovery – ehemaliger Datenbank-Adapter', () => {
  beforeEach(() => {
    resetStorageForTests();
  });

  it('große Stände laufen über den Studio-Speicher (kein IndexedDB)', async () => {
    await largeSetJson('dropmonk_presets', [{ id: 'a' }]);
    expect(await largeGetJson('dropmonk_presets')).toEqual([{ id: 'a' }]);
    await largeDelete('dropmonk_presets');
    expect(await largeGetJson('dropmonk_presets')).toBeNull();
  });
});
