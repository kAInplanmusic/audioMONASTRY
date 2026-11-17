// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const { manager, transport } = vi.hoisted(() => ({
  manager: { onSessionUpdate: (_info: any) => {}, onOutputBusy: vi.fn(() => () => {}), sendEndpointReport: vi.fn(), requestBackendMainTicket: vi.fn(async () => ({ ticket: 'ticket', session: 'studio', role: 'pa' })), createBackendMainSocket: vi.fn() },
  transport: { callbacks: null as any, socket: { onclose: null as null | (() => void), close: vi.fn() }, activate: vi.fn(async () => {}), play: vi.fn(async () => true), close: vi.fn(async () => {}) },
}));
vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: manager }));
vi.mock('../src/core/transport/backendMainClient', () => ({
  BackendMainPlayback: class { activate = transport.activate; play = transport.play; close = transport.close; },
  connectBackendMain: (_ticket: unknown, callbacks: unknown) => { transport.callbacks = callbacks; return transport.socket; },
}));
import { MasterOutPage } from '../src/pages/MasterOutPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function setup() {
  transport.callbacks = null; transport.socket.onclose = null;
  const div = document.createElement('div'); const root = createRoot(div);
  await act(async () => root.render(<MasterOutPage />));
  await act(async () => { manager.onSessionUpdate({ joined: true }); await Promise.resolve(); });
  return { div, root };
}
it('shows the first backend error and ignores a later socket close', async () => {
  const { div, root } = await setup();
  await act(async () => { transport.callbacks.error(new Error('FLAC decode failed')); transport.socket.onclose?.(); });
  expect(div.textContent).toContain('FLAC decode failed');
  expect(div.textContent).toContain('Ausgabe gestoppt');
  expect(div.textContent).not.toContain('Backend Main connection closed');
  await act(async () => root.unmount());
});
it('does not let stale backend ready or delayed playback clear an error', async () => {
  let finish!: (value: boolean) => void;
  transport.play.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { div, root } = await setup();
  await act(async () => { transport.callbacks.ready({ sampleRate: 96000, channels: 2 }); });
  await act(async () => { div.querySelector('button')!.click(); });
  let pending!: Promise<void>;
  await act(async () => { pending = transport.callbacks.chunk({ sampleRate: 96000 }, new ArrayBuffer(0)); await Promise.resolve(); });
  await act(async () => { transport.callbacks.error(new Error('Main underrun')); transport.callbacks.ready({ sampleRate: 96000, channels: 2 }); finish(true); await pending; });
  expect(div.textContent).toContain('Main underrun'); expect(div.textContent).toContain('Ausgabe gestoppt');
  expect(div.textContent).not.toContain('Backend-Main aktiv');
  await act(async () => root.unmount());
});
