// @vitest-environment jsdom
import React, { useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const { manager, listeners } = vi.hoisted(() => {
  const listeners: Record<string, (message: any) => void> = {};
  const listen = (name: string) => (cb: (message: any) => void) => { listeners[name] = cb; return () => {}; };
  return { listeners, manager: {
    userId: 'user-me', delegationProof: vi.fn(() => null), requestSessionResync: vi.fn(),
    sendPluginLock: vi.fn(), sendPluginUnlock: vi.fn(), sendPluginLockTransfer: vi.fn(),
    onPluginLock: listen('lock'), onPluginUnlock: listen('unlock'),
    onPluginLockDenied: listen('denied'), onPluginLocksSync: listen('sync'), onSessionState: listen('session'),
  } };
});
vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: manager }));
vi.mock('../src/utils/pluginSettings', () => ({ setPluginSettingsHolderCheck: vi.fn() }));
import { PluginManagerProvider, usePluginManager } from '../src/context/PluginManagerContext';

const api: { current: ReturnType<typeof usePluginManager> | null } = { current: null };
function Harness() {
  const value = usePluginManager();
  useEffect(() => { api.current = value; });
  return null;
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); api.current = null; });

it('does not renew a released lock when a delayed lock confirmation arrives', () => {
  vi.useFakeTimers();
  render(<PluginManagerProvider><Harness /></PluginManagerProvider>);
  act(() => { api.current!.requestLock('biblio', 'user-me'); });
  act(() => { listeners.lock({ pluginId: 'biblio', lockedBy: 'user-me', timestamp: Date.now() }); });
  act(() => { vi.advanceTimersByTime(20_000); }); // renewal is now in flight
  expect(manager.sendPluginLock).toHaveBeenCalledTimes(2);
  act(() => { api.current!.releaseLock('biblio', 'user-me'); });
  expect(manager.sendPluginUnlock).toHaveBeenCalledWith('biblio');
  act(() => { listeners.lock({ pluginId: 'biblio', lockedBy: 'user-me', timestamp: Date.now() }); });
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(manager.sendPluginLock).toHaveBeenCalledTimes(2);
  act(() => { api.current!.requestLock('biblio', 'user-me'); });
  act(() => { vi.advanceTimersByTime(20_000); });
  expect(manager.sendPluginLock).toHaveBeenCalledTimes(4);
});
