// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../src/utils/privateMonitorTransport', () => ({
  PrivateMonitorTransport: class { update = update; dispose() {} },
}));
vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: {} }));
vi.mock('../src/utils/audioEngine', () => ({ audioEngine: { setPrivateMainMonitorStream: vi.fn().mockResolvedValue(undefined) } }));
import { usePrivateMonitor } from '../src/hooks/usePrivateMonitor';

afterEach(() => { cleanup(); update.mockClear(); });
it('includes the local user when session peers omit self, including after membership changes', () => {
  const { rerender } = renderHook(({ userId, memberIds }) => usePrivateMonitor({ userId, ownerId: 'owner', memberIds }), {
    initialProps: { userId: 'listener', memberIds: ['owner', 'other'] },
  });
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ memberIds: ['listener', 'other', 'owner'] }));
  rerender({ userId: 'listener', memberIds: ['owner', 'listener', 'new'] });
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ memberIds: ['listener', 'new', 'owner'] }));
});
