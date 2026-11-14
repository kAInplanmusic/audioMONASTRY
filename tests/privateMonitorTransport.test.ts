import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrivateMonitorTransport, type PrivateMonitorSignal } from '../src/utils/privateMonitorTransport';
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
class FakeStream {
 constructor(public tracks: any[] = [], public id = 'stream') {}
 getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
}
class FakePeer {
 static peers: FakePeer[] = [];
 static delayedOffer: Promise<RTCSessionDescriptionInit> | undefined;
 localDescription: RTCSessionDescriptionInit | null = null;
 remoteDescription: RTCSessionDescriptionInit | null = null;
 connectionState = 'new'; closed = false;
 onicecandidate: ((event: any) => void) | null = null;
 ontrack: ((event: any) => void) | null = null;
 onconnectionstatechange: (() => void) | null = null;
 transceivers: { direction: string; track?: any }[] = [];
 candidates: any[] = [];
 calls: string[] = [];
 constructor() { FakePeer.peers.push(this); }
 addTransceiver(track: any, options: any) { this.transceivers.push({ track, direction: options.direction }); }
 getTransceivers() { return this.transceivers; }
 async createOffer() { return FakePeer.delayedOffer ?? { type: 'offer' as const, sdp }; }
 async createAnswer() { return { type: 'answer' as const, sdp }; }
 async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; this.calls.push('local'); }
 async setRemoteDescription(value: RTCSessionDescriptionInit) { this.remoteDescription = value; this.calls.push('remote'); if (!this.transceivers.length) this.transceivers.push({ direction: 'sendrecv' }); }
 async addIceCandidate(candidate: any) { this.candidates.push(candidate); this.calls.push('candidate'); }
 close() { this.closed = true; }
}
const tick = () => new Promise(r => setTimeout(r, 0));
function fixture() {
 let receive: (signal: PrivateMonitorSignal) => void = () => {};
 const send = vi.fn(), audio = vi.fn(), error = vi.fn(), unsubscribe = vi.fn();
 const transport = new PrivateMonitorTransport({ sendSignal: send, subscribeSignals: cb => { receive = cb; return unsubscribe; },
  getRtcConfiguration: () => ({ iceServers: [] }), onAudioStream: audio, onError: error });
 return { transport, send, audio, error, unsubscribe, signal: (signal: PrivateMonitorSignal) => receive(signal) };
}
beforeEach(() => { FakePeer.peers = []; FakePeer.delayedOffer = undefined; vi.stubGlobal('RTCPeerConnection', FakePeer); vi.stubGlobal('MediaStream', FakeStream); });
afterEach(() => vi.unstubAllGlobals());
it('owner sends only borrowed audio, one send-only private connection per other member; no self/video, no track stop', async () => {
 const f = fixture(), stop = vi.fn();
 const stream = new FakeStream([{ kind: 'audio', id: 'audio1', stop }, { kind: 'video', id: 'video1', stop }]) as unknown as MediaStream;
 const state = { userId: 'owner', ownerId: 'owner', memberIds: ['owner', 'a', 'b', 'c'], stream };
 f.transport.update(state); await tick();
 expect(FakePeer.peers).toHaveLength(3);
 for (const pc of FakePeer.peers) expect(pc.transceivers).toEqual([{ direction: 'sendonly', track: stream.getAudioTracks()[0] }]);
 expect(f.send.mock.calls.map(call => call[0].targetUserId).sort()).toEqual(['a', 'b', 'c']);
 f.transport.update({ ...state, memberIds: [...state.memberIds].reverse() }); expect(FakePeer.peers).toHaveLength(3);
 const oldTrack = FakePeer.peers[0].ontrack!; f.audio.mockClear(); oldTrack({ track: { kind: 'audio' }, streams: [stream] }); expect(f.audio).not.toHaveBeenCalled();
 f.transport.dispose(); expect(FakePeer.peers.every(pc => pc.closed)).toBe(true); expect(stop).not.toHaveBeenCalled(); expect(f.unsubscribe).toHaveBeenCalledOnce();
});
it('member accepts only current-owner audio, queues early ICE and answers recv-only; foreign/video messages ignored', async () => {
 const f = fixture(); f.transport.update({ userId: 'a', ownerId: 'owner', memberIds: ['owner', 'a', 'b'] });
 f.signal({ senderUserId: 'b', targetUserId: 'a', type: 'offer', sdp });
 f.signal({ senderUserId: 'owner', targetUserId: 'a', type: 'offer', sdp: sdp + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });
 expect(FakePeer.peers).toHaveLength(0);
 f.signal({ senderUserId: 'owner', targetUserId: 'a', type: 'candidate', candidate: { candidate: 'early' } }); await tick();
 const pc = FakePeer.peers[0]; expect(pc.candidates).toEqual([]);
 f.signal({ senderUserId: 'owner', targetUserId: 'a', type: 'offer', sdp }); await tick();
 expect(pc.calls.indexOf('remote')).toBeLessThan(pc.calls.indexOf('candidate'));
 expect(pc.candidates).toEqual([{ candidate: 'early' }]); expect(pc.transceivers.every(t => t.direction === 'recvonly')).toBe(true);
 expect(f.send).toHaveBeenCalledWith({ targetUserId: 'owner', type: 'answer', sdp });
 const audio = { kind: 'audio', id: 'track' }, video = { kind: 'video' };
 pc.ontrack!({ track: audio, streams: [new FakeStream([audio, video])] });
 expect(f.audio.mock.calls.at(-1)?.[0].getAudioTracks()).toEqual([audio]);
 const staleTrack = pc.ontrack!; f.transport.update({ userId: 'a', ownerId: 'b', memberIds: ['owner', 'a', 'b'] });
 expect(pc.closed).toBe(true); f.audio.mockClear(); staleTrack({ track: audio, streams: [] }); expect(f.audio).not.toHaveBeenCalled(); f.transport.dispose();
});
it('owner change while offer is pending prevents stale description or signaling; dispose is idempotent', async () => {
 let resolveOffer!: (value: RTCSessionDescriptionInit) => void;
 FakePeer.delayedOffer = new Promise(r => { resolveOffer = r; });
 const f = fixture(), stop = vi.fn(); f.transport.update({ userId: 'owner', ownerId: 'owner', memberIds: ['owner', 'a'], stream: new FakeStream([{ kind: 'audio', id: 'audio', stop }]) as unknown as MediaStream });
 const old = FakePeer.peers[0]; f.transport.update({ userId: 'owner', ownerId: 'a', memberIds: ['owner', 'a'] });
 resolveOffer({ type: 'offer', sdp }); await tick();
 expect(old.closed).toBe(true); expect(old.localDescription).toBeNull(); expect(f.send).not.toHaveBeenCalled();
 f.transport.dispose(); f.transport.dispose(); expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
});
