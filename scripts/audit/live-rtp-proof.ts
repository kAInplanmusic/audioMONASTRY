/** Local browser staging only: actual P2P audio + production signaling/locks. */
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { attestRtpContexts } from './live-rtp-attestation';
import { hostname } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
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
const allowed = (host: string, port: number) => ['127.0.0.1', 'localhost'].includes(host) && permittedPorts.has(port);
const localProxy = http.createServer((req, res) => {
  const target = new URL(req.url || '/', base);
  if (!allowed(target.hostname, Number(target.port))) { res.writeHead(403); res.end(); return; }
  const upstream = http.request(target, { method: req.method, headers: req.headers }, incoming => {
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
const directory = resolve(process.env.LIVE_RTP_OUTPUT || 'test-results/rtp-proof-' + Date.now());
mkdirSync(directory, { recursive: true, mode: 0o700 });
const sessionId = 'rtp-proof-' + Date.now();
// Synthetic billing exists ONLY in this test fixture. RTP and handovers are real.
const billing = http.createServer((_req,res) => {res.setHeader('content-type','application/json');res.end(JSON.stringify({sessionId,currency:'EUR',totalEur:0,observedAt:Date.now(),source:'simulation',scopeComplete:true}));});
await new Promise<void>(r=>billing.listen(0,'127.0.0.1',r));
const billingPort = (billing.address() as import('node:net').AddressInfo).port;
const pages: import('playwright').Page[] = [];
const contexts: import('playwright').BrowserContext[] = [];
const browserErrors: string[] = [];
let testSession: ReturnType<typeof spawn> | undefined;
let collector: ReturnType<typeof spawn> | undefined;
let log = '';
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
    await page.goto(base + path + '?liveAudit=1');
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
        manager.onSessionUpdate = () => start(); start();
        (window as any).stopRetry = startMainStreamRetry({ ready: () => Boolean(manager.getMainStream()), mark: () => {}, start });
      }
    });
    await page.waitForFunction(() => Boolean((window as any).auditManager?.userId));
  }
  const output=pages[4];
  await output.waitForFunction(()=>(window as any).audioTrace?.at(-1)?.rms > .02,undefined,{timeout:20000});
  testSession=spawn(process.execPath,['-e',"console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']});
  await new Promise<void>(r=>testSession!.stdout!.once('data',()=>r()));
  collector=spawn(process.execPath,['--import','tsx','tests/fixtures/live-collector-simulation.ts'],{env:{...process.env,NODE_ENV:'test',LIVE_AUDIT_CDP:'http://127.0.0.1:9239',LIVE_AUDIT_ORIGIN:base,LIVE_AUDIT_SFU_HEALTH:base+'/api/health',LIVE_AUDIT_OUTPUT:directory,LIVE_AUDIT_SESSION_ID:sessionId,LIVE_AUDIT_SECONDS:'68',LIVE_AUDIT_SESSION_PID:String(testSession.pid),LIVE_AUDIT_COST_API:`http://127.0.0.1:${billingPort}/cost`,LIVE_AUDIT_COST_TOKEN:''},stdio:['ignore','pipe','pipe']});
  collector.stdout!.on('data',d=>{log+=d;});collector.stderr!.on('data',d=>{log+=d;});
  const exited = new Promise<number|null>(r=>collector!.once('exit',r));
  for(let i=1;i<4;i++) {
    await new Promise(r=>setTimeout(r,15000));
    if(collector.exitCode!==null) throw new Error('Collector stopped before transfer: '+log);
    const nextId=await pages[i].evaluate(()=>(window as any).auditManager.userId);
    await pages[i].evaluate(()=>{(window as any).permitStream=false;});
    await pages[i-1].evaluate(to=>(window as any).auditManager.sendPluginLockTransfer('mixer',to),nextId);
    await pages[i].waitForFunction(()=>(window as any).auditManager.isMainOutOwner);
    await new Promise(r=>setTimeout(r,500));
    await pages[i].evaluate(()=>{(window as any).permitStream=true;});
    await pages[i].waitForFunction(()=>Boolean((window as any).auditManager.getMainStream()),undefined,{timeout:10000});
    await output.waitForFunction(owner=>(window as any).auditManager.hostId===owner && (window as any).audioTrace?.at(-1)?.rms>.02,nextId,{timeout:10000});
  }
  const code=await exited;
  writeFileSync(join(directory,'collector.log'),log,{mode:0o600});
  if(code!==0)throw new Error('Collector exited '+code+': '+log);
  const summary=JSON.parse(readFileSync(join(directory,'summary.json'),'utf8'));
  const rows=readFileSync(join(directory,'raw.ndjson'),'utf8').trim().split('\n').map(line => JSON.parse(line));
  const attestation = attestRtpContexts(rows);
  const trace=await output.evaluate(()=>(window as any).audioTrace);
  const report={mode:'local-rtp-test',hostname:hostname(),browserVersion:browser.version(),costs:'simulation in test fixture ONLY; actual cost channel blocked',...attestation,handovers:summary.handovers,summary:summary.summary,stopReason:summary.stopReason,browserErrors,glitchRateStatus:'nicht gemessen: keine Blockzähler',scope:'four member contexts plus one Main-Out page in first context; loopback TCP TURN; P2P RTP, local SFU health only, no SFU media or WAN or PA latency proof',directory};
  writeFileSync(join(directory,'rtp-attestation.json'),JSON.stringify(report,null,2),{mode:0o600});
  writeFileSync(join(directory,'receiver-rms.json'),JSON.stringify(trace),{mode:0o600});
  console.log(JSON.stringify(report,null,2));
  assert.equal(attestation.contextRtpSamples.length,4);assert.ok(attestation.trafficSeconds!==null && attestation.trafficSeconds>=60);assert.ok(summary.handovers.length>=1);assert.equal(summary.stopReason,'duration-complete');
} finally {
  if(collector&&collector.exitCode===null)collector.kill('SIGTERM');
  if(testSession&&testSession.exitCode===null)testSession.kill('SIGTERM');
  writeFileSync(join(directory,'collector.log'),log,{mode:0o600});
  writeFileSync(join(directory,'browser-errors.json'),JSON.stringify(browserErrors),{mode:0o600});
  await browser.close();await hub.close();hub.io.close();runtime.stop();await vite.close();
  localProxy.closeAllConnections();await new Promise<void>(r=>localProxy.close(()=>r()));
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  await new Promise<void>(r=>billing.close(()=>r()));
}
