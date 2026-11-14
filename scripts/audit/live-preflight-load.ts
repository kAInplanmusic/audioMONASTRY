/** Local browser staging only: actual P2P audio + production signaling/locks. */
import http from 'node:http';
import net from 'node:net';
import { sampleSessionMemory } from './live-memory-monitor';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createRealtimeHub } from '../../server/realtime';
import { createSessionRuntime } from '../../server/sessionRuntime';

// No server.ts import: no AI fleet timers, hooks, routes or cloud access.
process.env.NODE_ENV = 'test';
process.env.SESSION_STATE_FILE = 'off';
process.env.ENABLE_SFU = '1';
process.env.SFU_ANNOUNCED_IP = '127.0.0.1';
process.env.MEDIASOUP_WORKER_BIN = '/workspace/work/r5-mediasoup/mediasoup-worker';
process.env.LOCAL_TURN_URL = 'turn:127.0.0.1:3479?transport=tcp';
delete process.env.REDIS_URL;
if (process.env.LOCAL_TURN_URL && process.env.LOCAL_TURN_URL !== 'turn:127.0.0.1:3479?transport=tcp') {
  throw new Error('LOCAL_TURN_URL must be the documented loopback-only staging endpoint');
}
const runtime = createSessionRuntime();
const vite = await createServer({ configFile: false, appType: 'custom',
  server: { middlewareMode: true, hmr: false }, logLevel: 'error' });
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({status:'ok',sfu:hub.getSfuHealth()})); return; }
  if (req.url?.startsWith('/api/webrtc-config')) {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ iceServers: process.env.LOCAL_TURN_URL ? [{ urls: process.env.LOCAL_TURN_URL, username: 'local-audit', credential: 'local-audit' }] : [] })); return;
  }
  if (req.url?.startsWith('/src/') || req.url?.startsWith('/node_modules/') || req.url?.startsWith('/@') || req.url?.startsWith('/.vite/')) {
    vite.middlewares(req, res, () => { res.statusCode = 404; res.end(); }); return;
  }
  res.setHeader('content-type', 'text/html');
  res.end('<html><body>Local audit fixture</body></html>');
});
const hub = await createRealtimeHub(server, {
  sessionRuntime: runtime, addServerAudit: () => {},
  resolveSessionMainOutUserId: () => runtime.session.lockOwner('mixer') ?? '', pluginLockTtlMs: 60000,
  studioTokenMissing: false, studioAuthOpen: true, studioAccessToken: '', studioSessionSecret: '',
  safeTokenEqual: () => false, looksLikeStudioSession: () => false,
  verifyStudioSession: async () => false, log: () => {}, warn: () => {},
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('local staging port missing');
const base = `http://127.0.0.1:${address.port}`;
// The managed browser requires proxied WebRTC. This proxy can reach ONLY our
// two loopback test ports; it is not an open proxy and makes no external request.
const permittedPorts = new Set([address.port, 3479]);
const allowed = (host: string, port: number) => ['127.0.0.1', '127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5', 'localhost'].includes(host) && permittedPorts.has(port);
const localProxy = http.createServer((req, res) => {
  const target = new URL(req.url || '/', base);
  if (!allowed(target.hostname, Number(target.port))) { res.writeHead(403); res.end(); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers }, incoming => {
    res.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
});
localProxy.on('connect', (req, socket, head) => {
  const target = new URL(`http://${req.url}`); const port = Number(target.port);
  if (!allowed(target.hostname, port)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const upstream = net.connect(port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
localProxy.on('upgrade', (req, socket, head) => {
  const target = new URL(req.url || '/', base); const port = Number(target.port);
  if (!allowed(target.hostname, port)) { socket.destroy(); return; }
  const upstream = net.connect(port, '127.0.0.1', () => {
    upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
await new Promise<void>(r => localProxy.listen(0, '127.0.0.1', r));
const proxyAddress = localProxy.address();
if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('local proxy port missing');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=9239',
    `--proxy-server=http://127.0.0.1:${proxyAddress.port}`, '--proxy-bypass-list=<-loopback>'] });
const directory = resolve(process.env.LIVE_PREFLIGHT_OUTPUT!);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const pages: import('playwright').Page[] = [];
const contexts: import('playwright').BrowserContext[] = [];
const browserErrors: string[] = [];
let stopping = false;
let memoryTimer: ReturnType<typeof setInterval> | undefined;
let resolveStop: () => void;
const stopped = new Promise<void>(r => { resolveStop = r; });
const stop = () => { stopping = true; resolveStop(); };
process.on('SIGTERM', stop);process.on('SIGINT', stop);
try {
  if (!hub.getSfuHealth().ready) throw new Error('Real local SFU worker/router not ready');
  for(let i=0;i<4;i++) contexts.push(await browser.newContext());
  for(let i=0;i<5;i++) {
    const path=i===4?'/master-out':'/';
    const context=contexts[i===4?0:i];const page=await context.newPage();pages.push(page);
    page.on('pageerror',e=>browserErrors.push(e.message));
    await page.addInitScript(`globalThis.__name = (fn) => fn;
      globalThis.auditIceErrors = [];
      const NativePeer = globalThis.RTCPeerConnection;
      globalThis.RTCPeerConnection = class extends NativePeer {
        constructor(...args) { super(...args); this.addEventListener('icecandidateerror', e => {
          globalThis.auditIceErrors.push({code: e.errorCode, text: e.errorText});
        }); }
      };`);
    await page.goto(base.replace('127.0.0.1', `127.0.0.${i===4?2:i+2}`) + path + '?liveAudit=1');
    await page.evaluate(async () => {
      const { refreshIceConfig } = await import(String('/src/config/webrtc.ts'));
      await refreshIceConfig();
      const { webRTCManager: manager } = await import(String('/src/utils/WebRTCManager.ts'));
      (window as any).auditManager = manager;
      (window as any).auditContext = new AudioContext();
      const ctx = (window as any).auditContext as AudioContext;
      await ctx.resume();
      if (location.pathname === '/master-out') {
        const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
        // Chromium starts remote WebRTC decoding through an HTML media sink.
        // Mirror /master-out's explicit play(), with muted hardware output;
        // the analyser still observes the actual decoded remote stream.
        const playback = document.createElement('audio');
        playback.muted = true; document.body.appendChild(playback);
        let source: MediaStreamAudioSourceNode | null = null;
        manager.onRemoteStream = stream => {
          (window as any).remoteDeliveryCount = ((window as any).remoteDeliveryCount ?? 0) + 1;
          playback.srcObject = stream;
          void playback.play().catch(error => { (window as any).playbackError = String(error.name); });
          source?.disconnect(); source = ctx.createMediaStreamSource(stream); source.connect(analyser);
          analyser.connect(ctx.destination);
        };
        const trace: { ms: number; rms: number }[] = [];
        (window as any).audioTrace = trace;
        const values = new Float32Array(256);
        setInterval(() => {
          analyser.getFloatTimeDomainData(values);
          const rms = Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
          trace.push({ ms: performance.now(), rms });
        }, 20);
      } else {
        const { startMainStreamRetry } = await import(String('/src/utils/mainStreamRetry.ts'));
        (window as any).permitStream = true;
        const start = () => {
          if (!manager.isMainOutOwner || manager.getMainStream() || !(window as any).permitStream) return;
          const destination = ctx.createMediaStreamDestination();
          const oscillator = ctx.createOscillator(); oscillator.frequency.value = 440;
          oscillator.connect(destination); oscillator.start();
          (window as any).sourceTrack = destination.stream.getAudioTracks()[0];
          manager.startMainStream(destination.stream);
        };
        (window as any).auditStartMain = start;
        manager.onSessionUpdate = () => start(); start();
        setInterval(() => { if (manager.isMainOutOwner) manager.sendPluginLock('mixer'); }, 20000);
        (window as any).stopRetry = startMainStreamRetry({ ready: () => Boolean(manager.getMainStream()), mark: () => {}, start });
      }
    });
    await page.waitForFunction(() => Boolean((window as any).auditManager?.userId));
  }
  const output=pages[4];
  await output.waitForFunction(()=>(window as any).audioTrace?.at(-1)?.rms > .02,undefined,{timeout:20000});
  const memory = () => sampleSessionMemory(process.pid, join(directory, 'memory.ndjson'));
  memory(); memoryTimer = setInterval(memory, 60000);
  const origins = ['127.0.0.2','127.0.0.3','127.0.0.4','127.0.0.5'].map(host=>base.replace('127.0.0.1',host));
  const ready = { pid: process.pid, origin: base, origins, cdp:'http://127.0.0.1:9239',
    pages: await Promise.all(pages.map(p=>p.url())), browserVersion:browser.version(), at:new Date().toISOString() };
  writeFileSync(join(directory,'ready.json'),JSON.stringify(ready,null,2),{mode:0o600});
  console.log('PREFLIGHT_READY '+JSON.stringify(ready));
  let holder=0;
  for(let step=0;step<8&&!stopping;step++) {
    // First three transfers exercise every sender early, later transfers test
    // sustained authority and delivery. The guard can cancel this wait.
    await Promise.race([new Promise(r=>{const timer=setTimeout(r,step<3?15000:300000);timer.unref();}),stopped]);
    if(stopping)break;
    const next=(holder+1)%4;
    const nextId=await pages[next].evaluate(()=>(window as any).auditManager.userId);
    console.log('HANDOVER_BEGIN '+JSON.stringify({step,holder,next,at:new Date().toISOString()}));
    await pages[next].evaluate(()=>{(window as any).permitStream=false;});
    await pages[holder].evaluate(to=>(window as any).auditManager.sendPluginLockTransfer('mixer',to),nextId);
    await pages[next].waitForFunction(()=>(window as any).auditManager.isMainOutOwner);
    await new Promise(r=>setTimeout(r,500));
    await pages[next].evaluate(()=>{(window as any).permitStream=true;(window as any).auditStartMain();});
    await pages[next].waitForFunction(()=>Boolean((window as any).auditManager.getMainStream()),undefined,{timeout:10000});
    console.log('HANDOVER_SOURCE '+JSON.stringify(await pages[next].evaluate(()=>({owner:(window as any).auditManager.isMainOutOwner,tracks:(window as any).auditManager.getMainStream()?.getTracks().map((t:any)=>({kind:t.kind,readyState:t.readyState})),peers:(window as any).auditManager.getPeerConnectionStates()}))));
    await output.waitForFunction(owner=>(window as any).auditManager.hostId===owner&&(window as any).audioTrace?.at(-1)?.rms>.02,nextId,{timeout:10000});
    holder=next;console.log('HANDOVER '+JSON.stringify({step,holder,at:new Date().toISOString()}));
  }
  await stopped;
  memory();
  // No browser evaluation after SIGTERM: the collector/owner may already close its targets.
  writeFileSync(join(directory,'load-stopped.json'),JSON.stringify({signal:'SIGTERM',at:new Date().toISOString(),pid:process.pid,rawCheckpoint:JSON.parse(readFileSync(join(directory,'checkpoint.json'),'utf8'))}),{mode:0o600});

 } finally {
  if(memoryTimer)clearInterval(memoryTimer);
  writeFileSync(join(directory,'browser-errors.json'),JSON.stringify(browserErrors),{mode:0o600});
  await browser.close();await hub.close();hub.io.close();runtime.stop();await vite.close();
  localProxy.closeAllConnections();await new Promise<void>(r=>localProxy.close(()=>r()));
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  process.off('SIGTERM',stop);process.off('SIGINT',stop);
}
