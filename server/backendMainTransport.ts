import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { BACKEND_MAIN_HEADER_BYTES, BACKEND_MAIN_PATH, BACKEND_MAIN_RATES, type BackendMainRate, type BackendMainRole } from '../src/core/transport/backendMainProtocol';
import { BackendMainWorkerClient, type WorkerBlock } from './backendMainWorkerClient';
import { mainThreadCpu, mainCgroupCpu } from './backendMainCpu';
import type { MainProcessorSnapshot } from './backendMainProcessors';

type MaybePromise<T> = T | Promise<T>;
export interface BackendMainAccess<P> { principal: P; session: string; role: BackendMainRole; plugin?: string }
export interface BackendMainTransportOptions<P> {
  authenticate(request: IncomingMessage): MaybePromise<P | null>;
  /** Must verify session membership and, for contributors, the current canonical plugin lock/grant. */
  authorize(access: BackendMainAccess<P>): MaybePromise<boolean>;
  sampleRate?: (session: string) => BackendMainRate;
  /** Synchronous authoritative state, read immediately before aligned audio is rendered. */
  processorSnapshot?: (session: string) => MainProcessorSnapshot;
  ffmpegPath?: string;
  /** Auto starts with FLAC, falling back to byte-exact PCM24 when encoding cannot keep up. */
  encoding?: 'auto' | 'flac' | 'pcm24';
  /** Diagnostics only; no authorization or scheduling decisions derive from this callback. */
  onWorkerCreated?: (worker: BackendMainWorkerClient) => void;
  onMetrics?: (value: unknown) => void;
  encodeFlac?: (pcm: Buffer, sampleRate: BackendMainRate) => Promise<Buffer>;
}
interface Client<P> { streamId: string; ws: WebSocket; access: BackendMainAccess<P>; pending: Buffer[]; inFlight: Set<Buffer>; pendingBytes: number; processing: boolean }
interface Session<P> { mixer: BackendMainWorkerClient; clients: Set<Client<P>>; timer: ReturnType<typeof setInterval>; sequence: number; idleTicks: number; raw: boolean; fallbackReason?: 'encoder-slow' | 'encoder-delayed'; encodeMs?: number; output: Promise<void>; queuedBytes: number; renderedFrames: number; sentFrames: number; failed: boolean; sources: Map<string,Client<P>>; playback: Map<Client<P>, { playedFrame: number; scheduledEndFrame: number; wall: number }> }

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
    const session: Session<P> = { mixer: undefined as unknown as BackendMainWorkerClient, clients: new Set(), sequence: 0, idleTicks: 0, raw: options.encoding === 'pcm24', timer: undefined as unknown as ReturnType<typeof setInterval>, output: Promise.resolve(), queuedBytes: 0, renderedFrames: 0, sentFrames: 0, failed: false, playback: new Map(), sources: new Map() };
    const fail = (error: Error) => {
      if (session.failed || closed) return; session.failed = true;
      if (process.env.BACKEND_MAIN_AUDIT === '1') console.log('R14-FATAL '+JSON.stringify({wall:Date.now(),error:String(error)}));
      clearInterval(session.timer); session.mixer.close();
      for (const client of session.clients) client.ws.close(1011, 'Main audio worker/output failed');
      // Keep the failed epoch as a tombstone: reconnect cannot silently create frame zero.
    };
    const publish = async (result: WorkerBlock) => {
      if (session.failed || closed) return;
      for (const plugin of result.sourceIds) if (session.sources.get(plugin)?.streamId!==result.streamIds[plugin]) throw new Error('Main source generation changed before publication');
      for(const plugin of result.sourceIds) { const source=session.sources.get(plugin); if(!source||!await options.authorize(source.access)) throw new Error('Main source authority expired before publication'); }
      const current = options.processorSnapshot?.(id) ?? {};
      for (const [plugin, config] of Object.entries(result.snapshot)) {
        if (config?.active && (!current[plugin]?.active || current[plugin]?.epoch !== config.epoch)) throw new Error('Main processor authority changed before publication');
      }
      for (const client of [...session.clients]) {
        if (client.access.role === 'contributor' && !await options.authorize(client.access)) {
          evict(session, client);
          if (result.sourceIds.includes(client.access.plugin!)) throw new Error('Main contributor authority changed before publication');
        }
      }
      const receivers = [...session.clients].filter(c => c.access.role !== 'contributor' && c.ws.readyState === WebSocket.OPEN);
      if (!receivers.length) return;
      const pcm = Buffer.from(result.pcm), raw = session.raw, started = performance.now();
      const payload = raw ? pcm : await (options.encodeFlac ?? ((data, rate) => encodeMainFlac(data, rate, options.ffmpegPath)))(pcm, session.mixer.sampleRate);
      const elapsed = performance.now() - started;
      const delayedTicks = raw ? 0 : Math.floor(elapsed / 100);
      if (!raw && options.encoding !== 'flac' && (delayedTicks > 0 || elapsed > 80)) {
        session.raw = true; session.fallbackReason = delayedTicks ? 'encoder-delayed' : 'encoder-slow'; session.encodeMs = elapsed;
      }
      // Authorization is rechecked after awaited encoding; stale work is never released.
      const latest = options.processorSnapshot?.(id) ?? {};
      for (const [plugin, config] of Object.entries(result.snapshot)) {
        if (config?.active && (!latest[plugin]?.active || latest[plugin]?.epoch !== config.epoch)) throw new Error('Main processor authority expired during encoding');
      }
      for (const plugin of result.sourceIds) { const source=session.sources.get(plugin); if (!source || source.streamId!==result.streamIds[plugin] || !await options.authorize(source.access)) throw new Error('Main source authority expired during encoding'); }
      const sequence = session.sequence++;
      const meta = JSON.stringify({ type: 'chunk', delayedTicks, sequence, startFrame: result.startFrame, frames: result.frames, sampleRate: session.mixer.sampleRate, format: raw ? 's24le' : 'flac', ...(raw && session.fallbackReason ? { fallbackReason: session.fallbackReason } : {}), ...(!raw || session.encodeMs !== undefined ? {encodeMs: !raw ? elapsed : session.encodeMs} : {}), clippedSamples: result.clippedSamples, missingSamples: result.missingSamples, renderedFrames: session.renderedFrames, sentFrames: result.startFrame + result.frames, lagMs: result.lagMs });
      for (const client of receivers) {
        if (!await options.authorize(client.access)) { client.ws.close(1008, 'Main authorization expired'); continue; }
        if (closed || session.failed || client.ws.readyState !== WebSocket.OPEN) continue;
        if (client.ws.bufferedAmount + session.queuedBytes > 2 * 1024 * 1024) { client.ws.close(1013, 'Main receiver too slow'); continue; }
        // R16 §P3: peak/RMS/clipping of the finished backend block. Numbers only -
        // no audio frames travel here, and only receivers that just passed the same
        // authorization check as the audio chunk get it.
        client.ws.send(JSON.stringify({type:'waveform-peak',sequence,...result.waveform}));
        client.ws.send(meta); client.ws.send(payload, {binary:true});
        session.sentFrames = result.startFrame + result.frames;
      }
    };
    session.mixer = new BackendMainWorkerClient(options.sampleRate?.(id) ?? 96000, {
      block: result => {
        session.renderedFrames = result.renderedFrames;
        session.queuedBytes += result.pcm.byteLength;
        session.output = session.output.then(() => publish(result)).catch(fail).finally(() => { session.queuedBytes -= result.pcm.byteLength; session.mixer.ack(result.pcm.byteLength); });
      },
      error: fail,
      metrics: worker => {
        const value = {type:'main-metrics',wall:Date.now(),worker,mainCpu:mainThreadCpu(),cgroupCpu:mainCgroupCpu(),renderedFrames:session.renderedFrames,sentFrames:session.sentFrames,played:[...session.playback.values()]};
        options.onMetrics?.(value);
        if (process.env.BACKEND_MAIN_AUDIT === '1') console.log('R14-METRICS '+JSON.stringify(value));
      },
    });
    options.onWorkerCreated?.(session.mixer);
    let checking = false;
    session.timer = setInterval(() => {
      if (!session.clients.size && ++session.idleTicks >= 30) { clearInterval(session.timer); session.mixer.close(); sessions.delete(id); return; }
      if (session.clients.size) session.idleTicks = 0;
      if (checking || session.failed) return;
      checking = true;
      void (async () => {
        for (const client of [...session.clients]) if (client.access.role === 'contributor' && !await options.authorize(client.access)) evict(session,client);
        session.mixer.snapshot(options.processorSnapshot?.(id) ?? {});
        session.mixer.pruneDrainedTracks(new Set([...session.clients].filter(c=>c.access.role==='contributor').map(c=>c.access.plugin!)));
      })().catch(fail).finally(()=>{checking=false;});
    },100); session.timer.unref();
    sessions.set(id, session); return session;
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
      await session.mixer.ready;
      if (session.failed) throw new Error('Main audio epoch failed; explicit session restart required');
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
      await session.mixer.state();
      if (!await options.authorize(access) || closed || session.failed || socket.destroyed) throw new Error('Main authority changed during worker handshake');
      // No await between this uniqueness fence and synchronous registration.
      if (role === 'contributor' && [...session.clients].some(c=>c.access.role==='contributor'&&c.access.plugin===plugin)) throw new Error('Main contributor already connected');
      wss.handleUpgrade(req, socket, head, ws => {
        if (role === 'contributor') session.mixer.removeTrack(plugin!);
        const client: Client<P> = { streamId: randomUUID(), ws, access, pending: [], inFlight: new Set(), pendingBytes: 0, processing: false }; session.clients.add(client);
        if (role === 'contributor') session.sources.set(plugin!,client);
        ws.send(JSON.stringify({ type: 'ready', sampleRate: session.mixer.sampleRate, channels: 2, format: 's24le', frame: session.mixer.frame }));
        ws.on('error', () => {}); ws.on('close', () => {
          session.clients.delete(client); session.playback.delete(client);
          if (role === 'contributor') void Promise.resolve().then(() => options.authorize(access)).catch(() => false).then(allowed => {
            if (!allowed && ![...session.clients].some(c => c.access.role === 'contributor' && c.access.plugin === plugin)) session.mixer.removeTrack(plugin!);
          });
        });
        ws.on('message', (data, binary) => {
          if (!binary && role === 'pa') {
            try {
              if (data.toString().length > 1024) throw new Error('Oversized playback report');
              const report = JSON.parse(data.toString()); const previous = session.playback.get(client);
              if (report.type !== 'playback-progress' || report.sampleRate !== session.mixer.sampleRate || ![report.playedFrame,report.scheduledEndFrame,report.queuedFrames].every(x=>Number.isSafeInteger(x)&&x>=0) || report.playedFrame > report.scheduledEndFrame || report.scheduledEndFrame > session.sentFrames || report.queuedFrames !== report.scheduledEndFrame-report.playedFrame || (previous && report.playedFrame<previous.playedFrame)) throw new Error('Invalid playback progress');
              session.playback.set(client,{playedFrame:report.playedFrame,scheduledEndFrame:report.scheduledEndFrame,wall:Date.now()});
            } catch { client.ws.close(1008,'Invalid playback report'); }
            return;
          }
          if (!binary || role !== 'contributor' || client.pending.length + client.inFlight.size >= 128) { ws.close(1008, 'Invalid Main input'); return; }
          const packet = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
          if (packet.length < BACKEND_MAIN_HEADER_BYTES || packet.toString('ascii', 0, 4) !== 'BMA1' || packet.readUInt32LE(12) * 6 !== packet.length - BACKEND_MAIN_HEADER_BYTES) { ws.close(1008, 'Invalid Main packet'); return; }
          if (client.pendingBytes + packet.byteLength > 1024 * 1024) { ws.close(1008, 'Main input queue full'); return; }
          client.pending.push(packet); client.pendingBytes += packet.byteLength;
          if (client.processing) return;
          client.processing = true;
          void (async () => {
            while (client.pending.length && session.clients.has(client) && ws.readyState === WebSocket.OPEN) {
              const next = client.pending.shift()!;
              // Reserve the same original packet/byte budget through authorization and acknowledgement.
              client.inFlight.add(next);
              let allowed = false;
              try { allowed = await options.authorize(access); } catch { /* Authorization failure remains fail-closed. */ }
              if (!allowed || !session.clients.has(client) || ws.readyState !== WebSocket.OPEN) {
                client.inFlight.delete(next); client.pendingBytes -= next.byteLength; evict(session, client); return;
              }
              // MessagePort preserves enqueue order. An ACK must not limit the next packet's submission.
              void session.mixer.enqueue(plugin!, next.readUInt32LE(4), next.readUInt32LE(8), next.subarray(BACKEND_MAIN_HEADER_BYTES), client.streamId)
                .catch(() => evict(session, client, `Main input rejected: frame ${next.readUInt32LE(8)}, mixer ${session.mixer.frame}`))
                .finally(() => { if (client.inFlight.delete(next)) client.pendingBytes -= next.byteLength; });
            }
          })().catch(() => evict(session, client)).finally(() => { client.pendingBytes -= client.pending.reduce((sum, item) => sum + item.byteLength, 0); client.pending = []; client.processing = false; });
        });
      });
    })().catch(() => socket.destroy());
  };
  server.on('upgrade', upgrade);
  return { close() { closed = true; server.off('upgrade', upgrade); for (const session of sessions.values()) { clearInterval(session.timer); session.mixer.close(); for (const client of session.clients) client.ws.terminate(); } sessions.clear(); wss.close(); } };
}
