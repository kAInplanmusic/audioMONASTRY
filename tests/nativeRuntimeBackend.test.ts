import { describe, expect, it } from 'vitest';
import { NativeRuntimeClient } from '../src/core/audio/runtime/NativeRuntimeClient';
import type { IpcMessage, IpcResponse, IpcTransport } from '../src/core/audio/runtime/ipc';
import { NativeRuntimeAudioBackend } from '../src/core/audio/runtime/NativeRuntimeAudioBackend';

/** Mock-Transport: beantwortet Requests synchron aus einer Payload-Tabelle. */
class MockTransport implements IpcTransport {
  private onResponseCb: ((r: IpcResponse) => void) | null = null;
  private onMessageCb: ((m: IpcMessage) => void) | null = null;
  sent: IpcMessage[] = [];

  constructor(private payloads: Record<string, unknown>) {}

  send<T>(message: IpcMessage<T>): void {
    this.sent.push(message);
    const payload = this.payloads[message.channel];
    queueMicrotask(() => {
      this.onResponseCb?.({ id: message.id, ok: payload !== undefined, payload, error: payload === undefined ? 'unbekannt' : undefined });
    });
  }

  onMessage(cb: (message: IpcMessage) => void): void { this.onMessageCb = cb; }
  onResponse(cb: (response: IpcResponse) => void): void { this.onResponseCb = cb; }
  close(): void {}
  fireMessage(message: IpcMessage): void { this.onMessageCb?.(message); }
}

const DEVICE_LIST_PAYLOAD = {
  host: 'Alsa',
  backend: 'alsa',
  devices: [
    { id: 'out:Test IF', name: 'Test IF', direction: 'output', default_sample_rate: 48000, channels: 2, buffer_size: 512, sample_format: 'F32' },
    { id: 'in:Test IF', name: 'Test IF', direction: 'input', default_sample_rate: 96000, channels: 8, buffer_size: 256, sample_format: 'I16' },
  ],
};

describe('NativeRuntimeAudioBackend', () => {
  it('listet Geräte mit echten cpal-Capabilities (keine Annahmen)', async () => {
    const client = new NativeRuntimeClient(new MockTransport({ 'device.list': DEVICE_LIST_PAYLOAD }));
    client.connect();
    const backend = new NativeRuntimeAudioBackend(client);
    const devices = await backend.listDevices();

    expect(devices).toHaveLength(2);
    const out = devices.find((d) => d.id === 'out:Test IF')!;
    expect(out.backend).toBe('pipewire'); // alsa → pipewire-Klasse (Linux)
    expect(out.outputChannels).toBe(2);
    expect(out.capabilities?.sampleRates).toEqual([48000]);
    expect(out.capabilities?.bufferSizes).toEqual([512]);

    const input = devices.find((d) => d.id === 'in:Test IF')!;
    expect(input.inputChannels).toBe(8);
    expect(input.capabilities?.sampleRates).toEqual([96000]);
  });

  it('liefert Capabilities für einzelne Geräte', async () => {
    const client = new NativeRuntimeClient(new MockTransport({ 'device.list': DEVICE_LIST_PAYLOAD }));
    client.connect();
    const backend = new NativeRuntimeAudioBackend(client);
    await backend.listDevices();
    const caps = await backend.getCapabilities('out:Test IF');
    expect(caps.outputChannels).toBe(2);
    await expect(backend.getCapabilities('gibt-es-nicht')).rejects.toThrow(/nicht gefunden/);
  });

  it('leitet open-Fehler weiter (Gerätefehler isoliert)', async () => {
    const client = new NativeRuntimeClient(new MockTransport({ 'device.list': DEVICE_LIST_PAYLOAD }));
    client.connect();
    const backend = new NativeRuntimeAudioBackend(client);
    await backend.listDevices();
    await expect(backend.open('out:Test IF')).rejects.toThrow(/unbekannt/);
  });

  it('berechnet Buffer-ms nur aus echten Werten (kein Raten)', async () => {
    const client = new NativeRuntimeClient(new MockTransport({ 'device.list': DEVICE_LIST_PAYLOAD }));
    client.connect();
    const backend = new NativeRuntimeAudioBackend(client);
    await backend.listDevices();
    const latency = await backend.getLatency('out:Test IF');
    expect(latency.bufferMs).toBeCloseTo((512 / 48000) * 1000);
    expect(latency.inputLatencyMs).toBe(0);
    expect(latency.outputLatencyMs).toBe(0);
  });
});
