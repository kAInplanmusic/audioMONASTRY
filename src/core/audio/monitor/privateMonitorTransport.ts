/** Separate, one-way headphone audio. Never adds tracks to Main-Out peers. */
export interface PrivateMonitorSignal {
  senderUserId: string; targetUserId: string; type: 'offer' | 'answer' | 'candidate';
  sdp?: string; candidate?: RTCIceCandidateInit | null;
}
export interface PrivateMonitorState {
  userId: string; ownerId: string; memberIds: readonly string[]; stream?: MediaStream | null;
}
export interface PrivateMonitorDeps {
  sendSignal(signal: Omit<PrivateMonitorSignal, 'senderUserId'>): void;
  subscribeSignals(listener: (signal: PrivateMonitorSignal) => void): () => void;
  getRtcConfiguration(): RTCConfiguration;
  onAudioStream(stream: MediaStream | null): void;
  onError?(error: Error): void;
}
interface Peer {
  pc: RTCPeerConnection; pending: (RTCIceCandidateInit | null)[]; incoming: Promise<void>;
}
const audioSdp = (sdp: string | undefined) => {
  if (typeof sdp !== 'string') return false;
  const media = sdp.split(/\r?\n/).filter(line => line.startsWith('m='));
  return sdp.startsWith('v=0') && media.length > 0 && media.every(line => /^m=audio\s/.test(line));
};
export class PrivateMonitorTransport {
  private state: PrivateMonitorState = { userId: '', ownerId: '', memberIds: [] };
  private key = '';
  private epoch = 0;
  private disposed = false;
  private peers = new Map<string, Peer>();
  private unsubscribe: () => void;
  constructor(private readonly deps: PrivateMonitorDeps) {
    this.unsubscribe = deps.subscribeSignals(signal => this.receive(signal));
  }
  update(state: PrivateMonitorState): void {
    if (this.disposed) return;
    const members = [...new Set(state.memberIds.filter(Boolean))].sort();
    const stream = state.userId === state.ownerId ? state.stream : null;
    const key = JSON.stringify([state.userId, state.ownerId, members, stream?.id ?? '', stream?.getAudioTracks().map(t => t.id) ?? []]);
    if (key === this.key) return;
    this.reset(); this.key = key; this.state = { ...state, memberIds: members, stream };
    if (!state.userId || !state.ownerId || !members.includes(state.userId) || !members.includes(state.ownerId)) return;
    if (state.userId !== state.ownerId || !stream?.getAudioTracks().length) return;
    const epoch = this.epoch;
    for (const member of members) if (member !== state.userId) {
      const peer = this.create(member, epoch);
      // Borrow tracks from the existing master destination. Never stop them.
      for (const track of stream.getAudioTracks()) peer.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      void this.offer(member, peer, epoch);
    }
  }
  private active(id: string, peer: Peer, epoch: number): boolean {
    return !this.disposed && this.epoch === epoch && this.peers.get(id) === peer;
  }
  private create(id: string, epoch: number): Peer {
    const pc = new RTCPeerConnection(this.deps.getRtcConfiguration());
    const peer: Peer = { pc, pending: [], incoming: Promise.resolve() }; this.peers.set(id, peer);
    pc.onicecandidate = event => {
      if (!this.active(id, peer, epoch)) return;
      this.deps.sendSignal({ targetUserId: id, type: 'candidate', candidate: event.candidate?.toJSON() ?? null });
    };
    pc.ontrack = event => {
      if (!this.active(id, peer, epoch) || this.state.userId === this.state.ownerId || id !== this.state.ownerId || event.track.kind !== 'audio') return;
      const tracks = event.streams[0]?.getAudioTracks() ?? [event.track];
      this.deps.onAudioStream(new MediaStream(tracks));
    };
    pc.onconnectionstatechange = () => {
      if (this.active(id, peer, epoch) && pc.connectionState === 'failed') this.deps.onError?.(new Error('Private monitor audio connection failed'));
    };
    return peer;
  }
  private async offer(id: string, peer: Peer, epoch: number) {
    try {
      const offer = await peer.pc.createOffer();
      if (!this.active(id, peer, epoch)) return;
      await peer.pc.setLocalDescription(offer);
      if (!this.active(id, peer, epoch)) return;
      this.deps.sendSignal({ targetUserId: id, type: 'offer', sdp: peer.pc.localDescription?.sdp ?? offer.sdp });
    } catch (error) { if (this.active(id, peer, epoch)) this.error(error); }
  }
  private receive(signal: PrivateMonitorSignal) {
    if (this.disposed || !signal || signal.targetUserId !== this.state.userId || !this.state.memberIds.includes(signal.senderUserId)) return;
    const owner = this.state.userId === this.state.ownerId;
    if (owner ? signal.type === 'offer' || signal.senderUserId === this.state.userId : signal.senderUserId !== this.state.ownerId || signal.type === 'answer') return;
    if (!['offer', 'answer', 'candidate'].includes(signal.type)) return;
    if (signal.type !== 'candidate' && !audioSdp(signal.sdp)) return;
    const epoch = this.epoch, id = signal.senderUserId;
    let peer = this.peers.get(id);
    if (!peer) {
      if (owner) return; // No unsolicited answers/ICE may create owner connections.
      peer = this.create(id, epoch);
    }
    const current = peer;
    current.incoming = current.incoming.then(async () => {
      if (!this.active(id, current, epoch)) return;
      if (signal.type === 'candidate') {
        if (!current.pc.remoteDescription) current.pending.push(signal.candidate ?? null);
        else await current.pc.addIceCandidate(signal.candidate ?? undefined);
        return;
      }
      await current.pc.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
      if (!this.active(id, current, epoch)) return;
      for (const candidate of current.pending.splice(0)) {
        if (!this.active(id, current, epoch)) return;
        await current.pc.addIceCandidate(candidate ?? undefined);
      }
      if (signal.type === 'offer') {
        for (const transceiver of current.pc.getTransceivers()) transceiver.direction = 'recvonly';
        const answer = await current.pc.createAnswer();
        if (!this.active(id, current, epoch)) return;
        await current.pc.setLocalDescription(answer);
        if (this.active(id, current, epoch)) this.deps.sendSignal({ targetUserId: id, type: 'answer', sdp: current.pc.localDescription?.sdp ?? answer.sdp });
      }
    }).catch(error => { if (this.active(id, current, epoch)) this.error(error); });
  }
  private error(error: unknown) { this.deps.onError?.(error instanceof Error ? error : new Error('Private monitor negotiation failed')); }
  private reset() {
    this.epoch++;
    for (const peer of this.peers.values()) { peer.pc.ontrack = null; peer.pc.onicecandidate = null; peer.pc.onconnectionstatechange = null; peer.pc.close(); }
    this.peers.clear(); this.deps.onAudioStream(null);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.reset(); this.unsubscribe();
  }
}
