import { expect, it, vi } from 'vitest';
import { createBackendMainLazyPublisher } from '../src/core/audio/backendMainLazyPublisher';
import type { PluginAudioBlock } from '../src/plugins/plugin_interface';
const block = (value: number): PluginAudioBlock => ({ channels: [new Float32Array(480).fill(value), new Float32Array(480).fill(value)], frameCount: 480, sampleRate: 48000, timestamp: 0 });
it('opens only on real source audio and preserves all queued samples through the fresh handshake', async () => {
  const send = vi.fn(), close = vi.fn(), error = vi.fn();
  const open = vi.fn(async () => ({ send, close })); const lazy = createBackendMainLazyPublisher(open, error);
  lazy.send(block(0)); expect(open).not.toHaveBeenCalled();
  const first = block(.25), second = block(0); lazy.send(first); lazy.send(second); await Promise.resolve();
  expect(open).toHaveBeenCalledOnce(); expect(send.mock.calls.map(call => call[0])).toEqual([first, second]);
  lazy.close(); lazy.close(); expect(close).toHaveBeenCalledOnce(); expect(error).not.toHaveBeenCalled();
});
it('closes a late handshake after authority ends', async () => {
  const close = vi.fn(), send = vi.fn(); let resolve!: (value: {send: typeof send; close: typeof close}) => void;
  const lazy = createBackendMainLazyPublisher(() => new Promise(done => { resolve = done; }), vi.fn());
  lazy.send(block(.5)); lazy.close(); resolve({ send, close }); await Promise.resolve();
  expect(close).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
});
it('fails closed when a handshake cannot drain its bounded queue', () => {
  const error = vi.fn(); const lazy = createBackendMainLazyPublisher(() => new Promise(() => {}), error);
  for (let n = 0; n < 120; n++) lazy.send(block(.25));
  expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0][0].message).toContain('1000ms');
});

it('retires a drained idle stream and starts a fresh timeline for the next real source output', async () => {
  const first = { send: vi.fn(), close: vi.fn() }, second = { send: vi.fn(), close: vi.fn() };
  const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const lazy = createBackendMainLazyPublisher(open, vi.fn());
  lazy.send(block(.25)); await Promise.resolve();
  for (let n = 0; n < 201; n++) lazy.send(block(0));
  expect(first.close).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce();
  const resumed = block(.5); lazy.send(resumed); await Promise.resolve();
  expect(open).toHaveBeenCalledTimes(2); expect(second.send).toHaveBeenCalledWith(resumed);
  lazy.close();
});
