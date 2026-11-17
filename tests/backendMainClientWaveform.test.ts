// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { connectBackendMain } from '../src/core/transport/backendMainClient';

type Msg = string | ArrayBuffer;
class FakeSocket {
  binaryType = 'blob';
  onmessage: ((event: { data: Msg }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close() { this.closed = true; }
  deliver(data: Msg) { this.onmessage?.({ data }); }
}

const ticket = { ticket: 't', session: 'studio-session', role: 'pa' as const };
const chunk = (sequence: number, frames = 9600) => JSON.stringify({
  type: 'chunk', sequence, startFrame: 0, frames, sampleRate: 96000, format: 's24le', formatOk: true,
});

/** R16 §P3: telemetry must never be able to kill audio playback. */
describe('backend main client tolerates waveform telemetry', () => {
  it('accepts waveform-peak without closing the socket and keeps playing audio', async () => {
    const socket = new FakeSocket();
    const chunks: number[] = [];
    const errors: string[] = [];
    const waveforms: Record<string, unknown>[] = [];
    connectBackendMain(ticket, {
      ready: () => {},
      chunk: async (meta) => { chunks.push(meta.sequence); },
      error: e => errors.push(e.message),
      waveform: message => waveforms.push(message),
    }, () => socket as unknown as WebSocket);

    socket.deliver(JSON.stringify({ type: 'ready', sampleRate: 96000, channels: 2, format: 's24le', frame: 0 }));
    socket.deliver(chunk(0));
    socket.deliver(new ArrayBuffer(9600 * 6));
    socket.deliver(JSON.stringify({ type: 'waveform-peak', sequence: 0, peakL: 0.5, peakR: 0.4, rmsL: 0.2, rmsR: 0.1, clipped: 0, frame: 0, frames: 9600, sampleRate: 96000 }));
    socket.deliver(chunk(1));
    socket.deliver(new ArrayBuffer(9600 * 6));
    await vi.waitFor(() => expect(chunks).toEqual([0, 1]));

    expect(errors).toEqual([]);
    expect(socket.closed).toBe(false);
    expect(waveforms).toHaveLength(1);
    expect(waveforms[0]).toMatchObject({ peakL: 0.5, clipped: 0 });
  });

  it('still fails on an unknown message type', async () => {
    const socket = new FakeSocket();
    const errors: string[] = [];
    connectBackendMain(ticket, { ready: () => {}, chunk: async () => {}, error: e => errors.push(e.message) },
      () => socket as unknown as WebSocket);
    socket.deliver(JSON.stringify({ type: 'nonsense' }));
    await vi.waitFor(() => expect(errors).toEqual(['Unexpected backend Main message']));
    expect(socket.closed).toBe(true);
  });
});
