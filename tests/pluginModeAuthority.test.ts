import { describe, expect, it, vi } from 'vitest';
import { claimPluginMode } from '../src/utils/claimPluginMode';

describe('UI mode acquisition waits for server authority', () => {
  function fixture() {
    const locks = new Set<(m: any) => void>(), denied = new Set<(m: any) => void>();
    const controller = new AbortController();
    const promise = claimPluginMode({ pluginId: 'eq', actorId: 'me', signal: controller.signal,
      request: () => true, onLock: cb => { locks.add(cb); return () => locks.delete(cb); },
      onDenied: cb => { denied.add(cb); return () => denied.delete(cb); } });
    return { locks, denied, controller, promise };
  }
  it('does not activate from an optimistic request and ignores other plugins', async () => {
    const f = fixture(); const activate = vi.fn(); const done = f.promise.then(activate);
    await Promise.resolve(); expect(activate).not.toHaveBeenCalled();
    f.locks.forEach(cb => cb({ pluginId: 'stem', lockedBy: 'me' }));
    await Promise.resolve(); expect(activate).not.toHaveBeenCalled();
    f.locks.forEach(cb => cb({ pluginId: 'eq', lockedBy: 'me' }));
    await done; expect(activate).toHaveBeenCalledTimes(1); expect(f.locks.size + f.denied.size).toBe(0);
  });
  it('rejects denial or another server-attested holder without activation', async () => {
    const f = fixture(); const failed = expect(f.promise).rejects.toThrow('belegt');
    f.denied.forEach(cb => cb({ pluginId: 'eq' })); await failed;
    const g = fixture(); const other = expect(g.promise).rejects.toThrow('anderweitig');
    g.locks.forEach(cb => cb({ pluginId: 'eq', lockedBy: 'other' })); await other;
  });
  it('cancels pending requests on unmount and expires a missing server response', async () => {
    const f = fixture(); const cancelled = expect(f.promise).rejects.toThrow('abgebrochen');
    f.controller.abort(); await cancelled; expect(f.locks.size + f.denied.size).toBe(0);
    vi.useFakeTimers();
    try {
      const g = fixture(); const expired = expect(g.promise).rejects.toThrow('Lock-Bestätigung');
      await vi.advanceTimersByTimeAsync(5000); await expired;
      expect(vi.getTimerCount()).toBe(0); expect(g.locks.size + g.denied.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
