// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', () => {
  const socket = {
    id: 'socket-1',
    connected: false,
    on: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return { io: vi.fn(() => socket) };
});

import { webRTCManager } from '../src/utils/WebRTCManager';

describe('WebRTCManager (jsdom)', () => {
  it('fragt Mikrofon nur einmal an', async () => {
    const getUserMedia = vi.fn(async () => ({} as MediaStream));
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });

    await webRTCManager.startLocalAudio();
    await webRTCManager.startLocalAudio();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('sendData/SendToAllPeers sind ohne Peers unkritisch', () => {
    expect(() => webRTCManager.sendData({ type: 'test' })).not.toThrow();
    expect(() => webRTCManager.sendToAllPeers({ type: 'test' } as never)).not.toThrow();
  });

  it('addDataChannelListener unterstützt mehrere Listener (F2-Fix)', () => {
    const seen: string[] = [];
    const off1 = webRTCManager.addDataChannelListener((m: any) => seen.push('a:' + m.type));
    const off2 = webRTCManager.addDataChannelListener((m: any) => seen.push('b:' + m.type));
    const emitter = webRTCManager as unknown as { dispatchDataMessage: (d: any) => void };
    emitter.dispatchDataMessage({ type: 'X' });
    expect(seen).toEqual(['a:X', 'b:X']);
    off1();
    emitter.dispatchDataMessage({ type: 'Y' });
    expect(seen).toEqual(['a:X', 'b:X', 'b:Y']);
    off2();
  });
});
