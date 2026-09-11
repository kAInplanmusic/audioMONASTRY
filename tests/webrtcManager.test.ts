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
    // Gültiger Minimal-Stream: der Manager ruft spaeter getAudioTracks()/getTracks()
    // auf (z. B. in setSfuMode) – ein nacktes {} würde dort werfen.
    const minimalStream = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => minimalStream);
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

  it('P4-1: startMainStream speichert Main-Stream ohne Peers (kein Throw)', () => {
    const fakeStream = { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
    webRTCManager.startMainStream(fakeStream);
    expect(webRTCManager.getMainStream()).toBe(fakeStream);
  });

  it('P4-2: isHost/role default guest, bis Server-Rolle eintrifft', () => {
    expect(webRTCManager.isHost).toBe(false);
    expect(webRTCManager.role).toBe('guest');
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

  // ---- Ghost-User (Listener) + Visual-Track -------------------------------

  class FakeMediaStream {
    constructor(public tracks: any[] = []) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  }

  function installFakeMediaStream() {
    (window as unknown as { MediaStream: unknown }).MediaStream = FakeMediaStream as unknown as typeof MediaStream;
  }

  const audioTrack = { id: 'a1', kind: 'audio' } as unknown as MediaStreamTrack;
  const videoTrack = { id: 'v1', kind: 'video' } as unknown as MediaStreamTrack;

  it('sessionMode(): member / master-out / visual-out', () => {
    expect(webRTCManager.sessionMode()).toBe('member');
    webRTCManager.setMasterOutMode(true);
    expect(webRTCManager.sessionMode()).toBe('master-out');
    webRTCManager.setMasterOutMode(false);
    webRTCManager.setVisualOutMode(true);
    expect(webRTCManager.sessionMode()).toBe('visual-out');
    expect(webRTCManager.isVisualOutMode).toBe(true);
    webRTCManager.setVisualOutMode(false);
    expect(webRTCManager.sessionMode()).toBe('member');
  });

  it('publishVisualTrack legt den Track in den Main-Stream (P2P, keine Peers)', () => {
    installFakeMediaStream();
    const main = new FakeMediaStream([audioTrack]);
    webRTCManager.startMainStream(main as unknown as MediaStream);
    webRTCManager.publishVisualTrack(videoTrack);
    const result = webRTCManager.getMainStream() as unknown as FakeMediaStream;
    expect(result).toBeInstanceOf(FakeMediaStream);
    const kinds = result.getTracks().map((t) => t.kind).sort();
    expect(kinds).toEqual(['audio', 'video']);
    expect(result.getVideoTracks()[0]).toBe(videoTrack);
  });

  it('SFU: startMainStream produziert Audio UND Video', async () => {
    const sfu = {
      sendAudioTrack: vi.fn(async () => {}),
      sendVideoTrack: vi.fn(async () => {}),
      knownRemoteProducers: () => [],
      subscribeToPeer: vi.fn(async () => null),
      onProducersChanged: () => {},
    };
    webRTCManager.setSfuMode(true, sfu as never);
    const stream = new FakeMediaStream([audioTrack, videoTrack]);
    webRTCManager.startMainStream(stream as unknown as MediaStream);
    await Promise.resolve();
    expect(sfu.sendAudioTrack).toHaveBeenCalledWith(audioTrack);
    expect(sfu.sendVideoTrack).toHaveBeenCalledWith(videoTrack);
    webRTCManager.setSfuMode(false);
  });

  it('SFU: publishVisualTrack produziert den Canvas-Track als Video', async () => {
    const sfu = {
      sendAudioTrack: vi.fn(async () => {}),
      sendVideoTrack: vi.fn(async () => {}),
      knownRemoteProducers: () => [],
      subscribeToPeer: vi.fn(async () => null),
      onProducersChanged: () => {},
    };
    // Rest-Main-Stream des Vor-Tests leeren, damit nur der Publish zaehlt.
    installFakeMediaStream();
    webRTCManager.startMainStream(new FakeMediaStream([]) as unknown as MediaStream);
    webRTCManager.setSfuMode(true, sfu as never);
    webRTCManager.publishVisualTrack(videoTrack);
    await Promise.resolve();
    expect(sfu.sendVideoTrack).toHaveBeenCalledWith(videoTrack);
    expect(sfu.sendAudioTrack).not.toHaveBeenCalled();
    webRTCManager.setSfuMode(false);
  });
});
