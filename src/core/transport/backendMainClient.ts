import { createMainOutputAudioContext } from '../../utils/audioContextFactory';
import { BACKEND_MAIN_PATH, type BackendMainChunk, type BackendMainReady, type BackendMainRole } from './backendMainProtocol';

export interface MainTransportTicket { ticket: string; session: string; role: BackendMainRole; plugin?: string }
/** Main transport only. Browser monitors and their WebRTC paths are independent. */
export function connectBackendMain(ticket: MainTransportTicket, callbacks: {
  ready: (format: BackendMainReady) => void;
  chunk: (metadata: BackendMainChunk, flac: ArrayBuffer) => Promise<void>;
  error: (error: Error) => void;
}, createSocket: (url: string) => WebSocket): WebSocket {
  const url = new URL(BACKEND_MAIN_PATH, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket.ticket); url.searchParams.set('session', ticket.session); url.searchParams.set('role', ticket.role);
  if (ticket.plugin) url.searchParams.set('plugin', ticket.plugin);
  const socket = createSocket(url.toString()); socket.binaryType = 'arraybuffer';
  let metadata: BackendMainChunk | null = null, chain = Promise.resolve();
  socket.onmessage = event => {
    chain = chain.then(async () => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'ready') callbacks.ready(message);
        else if (message.type === 'chunk' && metadata === null && (message.format === 'flac' || message.format === 's24le')) metadata = message;
        else throw new Error('Unexpected backend Main message');
      } else {
        if (!metadata || !(event.data instanceof ArrayBuffer)) throw new Error('Missing Main FLAC metadata');
        const current = metadata; metadata = null; await callbacks.chunk(current, event.data);
      }
    }).catch(error => { callbacks.error(error instanceof Error ? error : new Error(String(error))); socket.close(); });
  };
  socket.onerror = () => callbacks.error(new Error('Backend Main connection failed'));
  return socket;
}

/** Playback receives only server-rendered FLAC, never a peer's MediaStream. */
export class BackendMainPlayback {
  private context: AudioContext | null = null;
  private nextTime = 0;
  private nextFrame: number | null = null;
  private nextSequence: number | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  async activate(sampleRate: number): Promise<void> {
    if (!this.context) this.context = createMainOutputAudioContext(sampleRate);
    if (this.context.sampleRate !== sampleRate) throw new Error('Output AudioContext does not support the Main sample rate');
    await this.context.resume();
  }
  async play(meta: BackendMainChunk, flac: ArrayBuffer): Promise<boolean> {
    if (!this.context || this.context.state !== 'running') return false;
    if ((this.nextFrame !== null && meta.startFrame !== this.nextFrame) || (this.nextSequence !== null && meta.sequence !== this.nextSequence)) throw new Error('Main transport discontinuity');
    const context = this.context;
    let buffer: AudioBuffer;
    if (meta.format === 's24le') {
      if (flac.byteLength !== meta.frames * 6) throw new Error('Raw Main frame length mismatch');
      buffer = context.createBuffer(2, meta.frames, meta.sampleRate);
      const input = new Uint8Array(flac), left = buffer.getChannelData(0), right = buffer.getChannelData(1);
      for (let frame = 0; frame < meta.frames; frame++) {
        const offset = frame * 6;
        const l = input[offset] | input[offset+1]<<8 | input[offset+2]<<16;
        const r = input[offset+3] | input[offset+4]<<8 | input[offset+5]<<16;
        left[frame] = (l & 0x800000 ? l - 0x1000000 : l) / 8388608;
        right[frame] = (r & 0x800000 ? r - 0x1000000 : r) / 8388608;
      }
    } else buffer = await context.decodeAudioData(flac.slice(0));
    if (buffer.sampleRate !== meta.sampleRate || buffer.numberOfChannels !== 2 || buffer.length !== meta.frames) throw new Error('Decoded Main format mismatch');
    if (this.nextTime === 0) this.nextTime = context.currentTime + 0.5;
    if (this.nextTime < context.currentTime) throw new Error('Main playback underrun; output stopped');
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    this.sources.add(source); source.onended = () => { source.disconnect(); this.sources.delete(source); };
    source.start(this.nextTime); this.nextTime += buffer.duration;
    this.nextFrame = meta.startFrame + meta.frames; this.nextSequence = meta.sequence + 1; return true;
  }
  async close(): Promise<void> {
    for (const source of this.sources) { try { source.stop(); } catch { /* already ended */ } source.disconnect(); }
    this.nextTime = 0; this.nextFrame = null; this.nextSequence = null;
    this.sources.clear(); await this.context?.close(); this.context = null;
  }
}
