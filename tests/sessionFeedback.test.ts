import { expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => {
  const handlers = new Map<string, (() => void)[]>();
  return {
    handlers,
    on: (event: string, listener: () => void) => handlers.set(event, [...(handlers.get(event) ?? []), listener]),
    emit: vi.fn(),
  };
});

vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('../src/config/runtime', () => ({ SOCKET_IO_SIGNALING_URL: '' }));
vi.mock('../src/config/webrtc', () => ({ refreshIceConfig: vi.fn() }));

import { SESSION_FEEDBACK, webRTCManager } from '../src/utils/WebRTCManager';

it('delivers each server notice once and requests authoritative state where needed', () => {
  const onFeedback = vi.fn();
  const unsubscribe = webRTCManager.onSessionFeedback(onFeedback);
  for (const [event, message] of Object.entries(SESSION_FEEDBACK)) {
    const receivers = socket.handlers.get(event) ?? [];
    expect(receivers).toHaveLength(1);
    for (const receive of receivers) receive();
    expect(onFeedback).toHaveBeenLastCalledWith(message, event);
  }
  expect(onFeedback).toHaveBeenCalledTimes(6);
  expect(socket.emit.mock.calls).toEqual([
    ['resync-session'], ['resync-session'], ['resync-session'],
  ]);
  unsubscribe();
  socket.handlers.get('store-rejected')?.[0]?.();
  expect(onFeedback).toHaveBeenCalledTimes(6);
});
