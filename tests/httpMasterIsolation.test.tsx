// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), source: vi.fn(), pcs: [] as any[] }));
vi.mock('../src/core/audio/compat/nativeAudioKit', () => ({
  start: vi.fn(async () => {}), context: { rawContext: { createMediaStreamSource: mocks.source }, createMediaStreamSource: () => ({ connect: mocks.connect }) },
  Transport: { bpm: { value: 120 }, start: vi.fn(), seconds: 0 }, Destination: {},
}));
vi.mock('../src/core/audio/worklets/loadAudioWorklets', () => ({ ensureAudioWorkletsLoaded: async () => ({ fallback: [] }) }));
vi.mock('../src/config/runtime', () => ({ SIGNALING_HTTP_EXPLICIT: false, SIGNALING_HTTP_URL: '', SIGNALING_TRANSPORT_URL: '' }));
import { AudioProvider, useAudio } from '../src/context/AudioContext';
class Peer {
  iceConnectionState = 'new'; ontrack?: (e: any) => void;
  constructor() { mocks.pcs.push(this); }
  addTransceiver() { return { setCodecPreferences: vi.fn() }; }
  createDataChannel() { return { readyState: 'closed' }; }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
  setLocalDescription() { return Promise.resolve(); }
  close() {}
}
vi.stubGlobal('RTCPeerConnection', Peer);
vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [] }) });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
async function mountAt(path: string) {
  window.history.replaceState({}, '', path);
  const div = document.createElement('div'); const root = createRoot(div);
  let start: (() => Promise<void>) | undefined;
  function Child() { start = useAudio().startAudio; return null; }
  await act(async () => { root.render(<AudioProvider><Child /></AudioProvider>); });
  await act(async () => { await start!(); });
  return root;
}
describe('A4 HTTP master receiver', () => {
  it('never creates a receiver in a studio browser', async () => {
    const before = mocks.pcs.length;
    const root = await mountAt('/');
    expect(mocks.pcs.length).toBe(before);
    await act(async () => root.unmount());
  });
  it('plays only at master-out and rejects a delayed track after navigation to studio', async () => {
    const root = await mountAt('/master-out');
    const pc = mocks.pcs.at(-1)!;
    mocks.connect.mockClear();
    pc.ontrack({ streams: [{}] });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    window.history.replaceState({}, '', '/');
    pc.ontrack({ streams: [{}] });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
