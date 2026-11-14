import { expect, it, vi } from 'vitest';
import { openBackendMainPublisher } from '../src/core/audio/backendMainPublisher';
import type { PluginAudioBlock } from '../src/plugins/plugin_interface';

function setup(rate = 96000) {
  const socket = { readyState: 1, onmessage: null as ((e: { data: string }) => void) | null, onerror: null as (() => void) | null, onclose: null as (() => void) | null, send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
  const onError = vi.fn();
  const opening = openBackendMainPublisher({ requestTicket: async () => ({ ticket: 't', session: 's', role: 'contributor', plugin: 'drop' }), createSocket: () => socket as unknown as WebSocket, origin: 'https://example.test', onError }, 'drop');
  const ready = async () => { await Promise.resolve(); socket.onmessage?.({ data: JSON.stringify({ type: 'ready', sampleRate: rate, frame: 1000, format: 's24le', channels: 2 }) }); return opening; };
  return { socket, onError, ready, opening };
}
function block(values: number[], rate = 96000): PluginAudioBlock { return { channels: [Float32Array.from(values), Float32Array.from(values)], frameCount: values.length, sampleRate: rate, timestamp: 0 }; }
it('encodes clipped PCM24 and advances sequence and timeline from server ready', async () => {
  const f = setup(); const publisher = await f.ready(); publisher.send(block([-1, 0, 1, 2, ...Array(956).fill(0)])); publisher.send(block(Array(960).fill(0.5)));
  const first = f.socket.send.mock.calls[0][0] as Uint8Array, second = f.socket.send.mock.calls[1][0] as Uint8Array;
  const h = new DataView(first.buffer); expect(h.getUint32(4, true)).toBe(0); expect(h.getUint32(8, true)).toBe(97000); expect(h.getUint32(12, true)).toBe(960);
  expect(Array.from(first.slice(16, 22))).toEqual([0, 0, 128, 0, 0, 128]); expect(Array.from(first.slice(28, 34))).toEqual([255, 255, 127, 255, 255, 127]);
  expect(new DataView(second.buffer).getUint32(8, true)).toBe(97960); expect(new DataView(second.buffer).getUint32(4, true)).toBe(1);
  publisher.close(); publisher.close(); expect(f.socket.close).toHaveBeenCalledOnce();
});
it('splits large blocks to at most 100ms and fails closed on backpressure', async () => {
  const f = setup(); const publisher = await f.ready(); publisher.send(block(Array(2000).fill(0)));
  expect(f.socket.send).toHaveBeenCalledTimes(2); expect(new DataView((f.socket.send.mock.calls[0][0] as Uint8Array).buffer).getUint32(12, true)).toBe(960);
  f.socket.bufferedAmount = 1024 * 1024; publisher.send(block(Array(960).fill(0))); expect(f.onError).toHaveBeenCalledOnce(); expect(f.socket.close).toHaveBeenCalledOnce();
});
it('resamples 48k sources for a 96k server and rejects rate changes', async () => {
  const f = setup(); const publisher = await f.ready(); publisher.send(block(Array(600).fill(0.5), 48000));
  expect(f.socket.send).toHaveBeenCalledOnce(); publisher.send(block([0], 96000)); expect(f.onError).toHaveBeenCalledOnce(); expect(f.socket.close).toHaveBeenCalledOnce();
});
it('rejects malformed ready before publishing', async () => {
  const f = setup(); await Promise.resolve(); f.socket.onmessage?.({ data: '{}' }); await expect(f.opening).rejects.toThrow('Invalid Main ready'); expect(f.socket.close).toHaveBeenCalledOnce();
});

it('closes and rejects when the server never sends ready', async () => {
  vi.useFakeTimers();
  try {
    const f = setup(); await Promise.resolve();
    const rejected = expect(f.opening).rejects.toThrow('ready timeout');
    await vi.advanceTimersByTimeAsync(5000); await rejected; expect(f.socket.close).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
