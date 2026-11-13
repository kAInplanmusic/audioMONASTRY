// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const { manager } = vi.hoisted(() => ({ manager: {
  isMasterOutMode: true, onRemoteStream: () => {}, onSessionUpdate: () => {},
  onOutputBusy: vi.fn(() => () => {}), sendEndpointReport: vi.fn(),
  onConnectionError: vi.fn((cb: (message: string) => void) => { cb('Verbindung zum Studio fehlgeschlagen.'); return () => {}; }),
} }));
vi.mock('../src/utils/WebRTCManager', () => ({ webRTCManager: manager }));
import { MasterOutPage } from '../src/pages/MasterOutPage';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('renders a connection failure instead of silently waiting for audio', async () => {
  const div = document.createElement('div'); const root = createRoot(div);
  await act(async () => root.render(<MasterOutPage />));
  expect(div.textContent).toContain('Verbindung zum Studio fehlgeschlagen.');
  expect(div.textContent).toContain('Verbindungsfehler');
  await act(async () => root.unmount());
});
