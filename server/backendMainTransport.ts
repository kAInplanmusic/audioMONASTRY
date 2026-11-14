import type { IncomingMessage, Server } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { BACKEND_MAIN_HEADER_BYTES, BACKEND_MAIN_PATH, BACKEND_MAIN_RATES, type BackendMainRate, type BackendMainRole } from '../src/core/transport/backendMainProtocol';
import { BackendMainMixer } from './backendMainMixer';

type MaybePromise<T> = T | Promise<T>;
export interface BackendMainAccess<P> { principal: P; session: string; role: BackendMainRole; plugin?: string }
export interface BackendMainTransportOptions<P> {
  authenticate(request: IncomingMessage): MaybePromise<P | null>;
  /** Must verify session membership and, for contributors, the current canonical plugin lock/grant. */
  authorize(access: BackendMainAccess<P>): MaybePromise<boolean>;
  sampleRate?: (session: string) => BackendMainRate;
  ffmpegPath?: string;
  /** Auto starts with FLAC, falling back to byte-exact PCM24 when encoding cannot keep up. */
  encoding?: 'auto' | 'flac' | 'pcm24';
  encodeFlac?: (pcm: Buffer, sampleRate: BackendMainRate) => Promise<Buffer>;
}
interface Client<P> { ws: WebSocket; access: BackendMainAccess<P>; pending: Buffer[]; processing: boolean }
interface Session<P> { mixer: BackendMainMixer; clients: Set<Client<P>>; timer: ReturnType<typeof setInterval>; encoding: boolean; checking: boolean; sequence: number; idleTicks: number; delayedTicks: number; raw: boolean; fallbackReason?: 'encoder-slow' | 'encoder-delayed'; encodeMs?: number }

/** Produces one complete, independently decodable FLAC stream with 24-bit samples. */
export function encodeMainFlac(pcm: Buffer, sampleRate: BackendMainRate, ffmpegPath = 'ffmpeg'): Promise<Buffer> {
  if (!BACKEND_MAIN_RATES.includes(sampleRate) || pcm.length === 0 || pcm.length % 6 || pcm.length > sampleRate * 6 / 4) return Promise.reject(new Error('Invalid FLAC input'));
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-v', 'error', '-f', 's24le', '-ar', String(sampleRate), '-ac', '2', '-i', 'pipe:0', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-f', 'flac', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0; let failed = false;
    const timeout = setTimeout(() => { failed = true; proc.kill('SIGKILL'); }, 5000); timeout.unref();
    proc.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > pcm.length * 2 + 65536) { failed = true; proc.kill('SIGKILL'); } else chunks.push(chunk); });
    proc.stderr.resume(); proc.stdin.on('error', () => {});
    proc.on('error', error => { clearTimeout(timeout); reject(error); });
    proc.on('close', code => { clearTimeout(timeout); if (failed || code !== 0) reject(new Error('Main FLAC encoding failed')); else resolve(Buffer.concat(chunks)); });
    proc.stdin.end(pcm);
  });
}

/** Attach only to a server that authenticates the HTTP upgrade. No identity is accepted from query parameters. */
export function attachBackendMainTransport<P>(server: Server, options: BackendMainTransportOptions<P>): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 192000 * 6 / 4 + BACKEND_MAIN_HEADER_BYTES, perMessageDeflate: false });
  const sessions = new Map<string, Session<P>>(); let closed = false;
  function sessionFor(id: string): Session<P> {
    const existing = sessions.get(id); if (existing) return existing;
    if (sessions.size >= 32) throw new Error('Main session limit');
    const mixer = new BackendMainMixer(options.sampleRate?.(id) ?? 96000);
    const session: Session<P> = { mixer, clients: new Set(), encoding: false, checking: false, sequence: 0, idleTicks: 0, delayedTicks: 0, raw: options.encoding === 'pcm24', timer: undefined as unknown as ReturnType<typeof setInterval> };
    const frames = mixer.sampleRate / 10;
    session.timer = setInterval(() => {
      if (!session.clients.size && ++session.idleTicks >= 30) { clearInterval(session.timer); sessions.delete(id); return; }
      if (session.clients.size) session.idleTicks = 0;
      // Preserve every output interval while the bounded single encoder is busy.
      // The timeline pauses and exposes delay instead of silently dropping audio.
      if (session.encoding || session.checking) { session.delayedTicks++; return; }
      session.checking = true;
      void (async () => {
      const contributors = [...session.clients].filter(c => c.access.role === 'contributor');
      const authorized = await Promise.all(contributors.map(c => Promise.resolve().then(() => options.authorize(c.access)).catch(() => false)));
      contributors.forEach((c, i) => { if (!authorized[i]) evict(session, c); });
      if (closed) return;
      const result = mixer.mix(frames);
      mixer.pruneDrainedTracks(new Set([...session.clients].filter(c => c.access.role === 'contributor').map(c => c.access.plugin!)));
      const receivers = [...session.clients].filter(c => c.access.role !== 'contributor' && c.ws.readyState === WebSocket.OPEN);
      if (!receivers.length) return;
      session.encoding = true; const sequence = session.sequence++;
      const raw = session.raw; const started = performance.now();
      const encoded = raw ? Promise.resolve(result.pcm) : (options.encodeFlac ?? ((pcm, rate) => encodeMainFlac(pcm, rate, options.ffmpegPath)))(result.pcm, mixer.sampleRate);
      void encoded.then(async payload => {
        const elapsed = raw ? session.encodeMs : performance.now() - started;
        const delayedTicks = session.delayedTicks; session.delayedTicks = 0;
        if (!raw && options.encoding !== 'flac' && (delayedTicks > 0 || (elapsed ?? 0) > 80)) {
          session.raw = true; session.fallbackReason = delayedTicks > 0 ? 'encoder-delayed' : 'encoder-slow'; session.encodeMs = elapsed;
        }
        const meta = JSON.stringify({ type: 'chunk', delayedTicks, sequence, startFrame: result.startFrame, frames, sampleRate: mixer.sampleRate, format: raw ? 's24le' : 'flac', ...(raw && session.fallbackReason ? { fallbackReason: session.fallbackReason } : {}), ...(elapsed !== undefined ? { encodeMs: elapsed } : {}), clippedSamples: result.clippedSamples, missingSamples: result.missingSamples });
        for (const client of receivers) {
          const allowed = await Promise.resolve().then(() => options.authorize(client.access)).catch(() => false);
          if (!allowed) { client.ws.close(1008, 'Main authorization expired'); continue; }
          if (client.ws.readyState !== WebSocket.OPEN) continue;
          if (client.ws.bufferedAmount > 2 * 1024 * 1024) { client.ws.close(1013, 'Main receiver too slow'); continue; }
          client.ws.send(meta); client.ws.send(payload, { binary: true });
        }
      }).catch(() => { for (const c of receivers) c.ws.close(1011, 'Main encoder failed'); }).finally(() => { session.encoding = false; });
      })().finally(() => { session.checking = false; });
    }, 100); session.timer.unref(); sessions.set(id, session); return session;
  }
  function evict(session: Session<P>, client: Client<P>, reason = 'Main authorization expired'): void {
    if (!session.clients.delete(client)) return;
    if (client.access.role === 'contributor' && client.access.plugin) session.mixer.removeTrack(client.access.plugin);
    client.ws.close(1008, reason);
  }
  const upgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost'); if (url.pathname !== BACKEND_MAIN_PATH) return;
    const role = url.searchParams.get('role'), id = url.searchParams.get('session'), plugin = url.searchParams.get('plugin') ?? undefined;
    if (!id || !/^[\w-]{1,128}$/.test(id) || !['contributor', 'pa', 'monitor'].includes(role ?? '') || (role === 'contributor' && (!plugin || !/^[\w-]{1,64}$/.test(plugin))) || (role !== 'contributor' && plugin)) { socket.destroy(); return; }
    void (async () => {
      const principal = await options.authenticate(req); if (principal == null) throw new Error('Unauthenticated');
      const access: BackendMainAccess<P> = { principal, session: id, role: role as BackendMainRole, plugin };
      if (!await options.authorize(access) || closed || socket.destroyed) throw new Error('Unauthorized');
      const session = sessionFor(id);
      if (role === 'contributor') {
        for (;;) {
          const previous = [...session.clients].find(c => c.access.role === 'contributor' && c.access.plugin === plugin);
          if (!previous) break;
          const stillAllowed = await Promise.resolve().then(() => options.authorize(previous.access)).catch(() => false);
          if (!session.clients.has(previous)) continue;
          if (stillAllowed) throw new Error('Main contributor already connected');
          evict(session, previous);
        }
        if (!await options.authorize(access) || closed || socket.destroyed) throw new Error('Unauthorized');
        if ([...session.clients].some(c => c.access.role === 'contributor' && c.access.plugin === plugin)) throw new Error('Main contributor already connected');
      }
      if (session.clients.size >= 24) throw new Error('Main connection limit');
      wss.handleUpgrade(req, socket, head, ws => {
        if (role === 'contributor') session.mixer.removeTrack(plugin!);
        const client: Client<P> = { ws, access, pending: [], processing: false }; session.clients.add(client);
        ws.send(JSON.stringify({ type: 'ready', sampleRate: session.mixer.sampleRate, channels: 2, format: 's24le', frame: session.mixer.frame }));
        ws.on('error', () => {}); ws.on('close', () => {
          session.clients.delete(client);
          if (role === 'contributor') void Promise.resolve().then(() => options.authorize(access)).catch(() => false).then(allowed => {
            if (!allowed && ![...session.clients].some(c => c.access.role === 'contributor' && c.access.plugin === plugin)) session.mixer.removeTrack(plugin!);
          });
        });
        ws.on('message', (data, binary) => {
          if (!binary || role !== 'contributor' || client.pending.length >= 128) { ws.close(1008, 'Invalid Main input'); return; }
          const packet = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
          if (packet.length < BACKEND_MAIN_HEADER_BYTES || packet.toString('ascii', 0, 4) !== 'BMA1' || packet.readUInt32LE(12) * 6 !== packet.length - BACKEND_MAIN_HEADER_BYTES) { ws.close(1008, 'Invalid Main packet'); return; }
          if (client.pending.reduce((sum, item) => sum + item.byteLength, 0) + packet.byteLength > 1024 * 1024) { ws.close(1008, 'Main input queue full'); return; }
          client.pending.push(packet);
          if (client.processing) return;
          client.processing = true;
          void (async () => {
            while (client.pending.length && session.clients.has(client) && ws.readyState === WebSocket.OPEN) {
              const next = client.pending[0];
              if (!await options.authorize(access) || !session.clients.has(client) || ws.readyState !== WebSocket.OPEN) { evict(session, client); return; }
              try {
                session.mixer.enqueue(plugin!, next.readUInt32LE(4), next.readUInt32LE(8), next.subarray(BACKEND_MAIN_HEADER_BYTES));
              } catch {
                evict(session, client, `Main input rejected: frame ${next.readUInt32LE(8)}, mixer ${session.mixer.frame}`); return;
              }
              client.pending.shift();
            }
          })().catch(() => evict(session, client)).finally(() => { client.pending = []; client.processing = false; });
        });
      });
    })().catch(() => socket.destroy());
  };
  server.on('upgrade', upgrade);
  return { close() { closed = true; server.off('upgrade', upgrade); for (const session of sessions.values()) { clearInterval(session.timer); for (const client of session.clients) client.ws.terminate(); } sessions.clear(); wss.close(); } };
}
