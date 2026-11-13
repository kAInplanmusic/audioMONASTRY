// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
const { handlers, socket } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return { handlers, socket: { id: 'a-owner', connected: true, on: vi.fn((event, cb) => handlers.set(event, cb)), emit: vi.fn(), connect: vi.fn() } };
});
vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('../src/config/webrtc', () => ({ rtcConfig: {}, refreshIceConfig: vi.fn() }));
class Stream {
  constructor(private tracks: any[] = []) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
}
class Peer {
  signalingState = 'stable'; iceConnectionState = 'new'; connectionState = 'new';
  senders: any[] = []; ontrack?: (event: any) => void;
  channels: any[] = []; transceivers: any[] = [];
  addTransceiver(kind: string, init: any) { this.transceivers.push({ kind, ...init }); }
  addTrack(track: any) { this.senders.push({ track }); }
  removeTrack(sender: any) { this.senders = this.senders.filter(s => s !== sender); }
  getSenders() { return this.senders; }
  getReceivers() { return []; }
  createDataChannel() { const dc = { readyState: 'open', send: vi.fn() }; this.channels.push(dc); return dc; }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: '' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  close() {}
}
vi.stubGlobal('RTCPeerConnection', Peer);
vi.stubGlobal('RTCSessionDescription', class { constructor(data: any) { Object.assign(this, data); } });
vi.stubGlobal('MediaStream', Stream);
import { webRTCManager as manager } from '../src/utils/WebRTCManager';
const audio = { kind: 'audio', id: 'main-audio' };
const video = { kind: 'video', id: 'main-video' };
afterEach(() => { window.history.replaceState({}, '', '/'); });

describe('A4 mocked studio, studio, audio-output and visual-output peers', () => {
  it('sends main audio exclusively to server-attested audio output while keeping studio data channels', async () => {
    const own = manager.userId;
    handlers.get('session-members')!({ members: [], mainOutUserId: own });
    await manager.connectToPeer('b-studio');
    await manager.connectToPeer('c-studio');
    handlers.get('session-endpoints')!({ endpoints: [
      { socketId: 'b-studio', mode: 'member' }, { socketId: 'c-studio', mode: 'member' },
      { socketId: 'd-audio', mode: 'master-out' }, { socketId: 'e-video', mode: 'visual-out' },
    ] });
    await manager.connectToPeer('d-audio');
    await manager.connectToPeer('e-video');
    manager.startMainStream(new Stream([audio, video]) as unknown as MediaStream);
    const peers = (manager as any).peerConnections as Map<string, Peer>;
    expect(peers.get('b-studio')!.senders).toEqual([]);
    expect(peers.get('c-studio')!.senders).toEqual([]);
    expect(peers.get('b-studio')!.channels).toHaveLength(1);
    expect(peers.get('d-audio')!.senders.map(s => s.track)).toEqual([audio]);
    expect(peers.get('e-video')!.senders.map(s => s.track)).toEqual([video]);
    const receive = vi.fn(); manager.onRemoteStream = receive;
    peers.get('b-studio')!.ontrack!({ streams: [new Stream([audio])], receiver: {} });
    expect(receive).not.toHaveBeenCalled();
    window.history.replaceState({}, '', '/master-out');
    handlers.get('session-members')!({ members: [{ socketId: 'b-studio', userId: 'dj' }], mainOutUserId: 'dj' });
    peers.get('b-studio')!.ontrack!({ streams: [new Stream([audio, video])], receiver: {} });
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0][0].getTracks()).toEqual([audio]);
  });
  it('initiates URL listeners for either socket ordering with a receive media section', async () => {
    manager.setSfuMode(false);
    window.history.replaceState({}, '', '/master-out');
    socket.id = 'z-listener';
    expect(manager.isMasterOutMode).toBe(true);
    await manager.connectToPeer('0-owner');
    const peer = (manager as any).peerConnections.get('0-owner') as Peer;
    expect(peer).toBeDefined();
    expect(peer.transceivers).toEqual([{ kind: 'audio', direction: 'recvonly' }]);
    window.history.replaceState({}, '', '/visual-out');
    expect(manager.isVisualOutMode).toBe(true);
    await manager.connectToPeer('1-owner');
    expect((manager as any).peerConnections.get('1-owner').transceivers).toEqual([{ kind: 'video', direction: 'recvonly' }]);
  });
  it('does not subscribe studio clients to SFU audio producers', () => {
    const sfu = { sendAudioTrack: vi.fn(async () => {}), sendVideoTrack: vi.fn(async () => {}), subscribeToPeer: vi.fn(async () => null), knownRemoteProducers: () => [{ producerId: 'foreign', kind: 'audio' }] };
    manager.setSfuMode(true, sfu as any);
    expect(sfu.subscribeToPeer).not.toHaveBeenCalled();
    manager.setSfuMode(false);
  });
});
