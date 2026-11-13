/** Local browser staging only: actual P2P audio + production signaling/locks. */
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createRealtimeHub } from '../../server/realtime';
import { createSessionRuntime } from '../../server/sessionRuntime';

// No server.ts import: no AI fleet timers, hooks, routes or cloud access.
process.env.NODE_ENV = 'test';
process.env.SESSION_STATE_FILE = 'off';
process.env.ENABLE_SFU = '0';
delete process.env.REDIS_URL;
if (process.env.LOCAL_TURN_URL && process.env.LOCAL_TURN_URL !== 'turn:127.0.0.1:3479?transport=tcp') {
  throw new Error('LOCAL_TURN_URL must be the documented loopback-only staging endpoint');
}
const runtime = createSessionRuntime();
const vite = await createServer({ configFile: false, appType: 'custom',
  server: { middlewareMode: true, hmr: false }, logLevel: 'error' });
const server = http.createServer((req, res) => {
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
  headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
    `--proxy-server=http://127.0.0.1:${proxyAddress.port}`, '--proxy-bypass-list=<-loopback>'] });
const results: Record<string, unknown>[] = [];
const pages: import('playwright').Page[] = [];
const browserErrors: string[] = [];
try {
  for (const path of ['/', '/', '/master-out']) {
    const context = await browser.newContext(); const page = await context.newPage();
    page.on('pageerror', e => browserErrors.push(e.message));
    page.on('console', m => { if (['warning', 'error'].includes(m.type())) browserErrors.push(m.text()); });
    pages.push(page);
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
        let source: MediaStreamAudioSourceNode | null = null;
        manager.onRemoteStream = stream => {
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
        let created = false;
        (window as any).permitStream = true;
        const start = () => {
          if (!manager.isMainOutOwner || created || !(window as any).permitStream) return;
          const destination = ctx.createMediaStreamDestination();
          const oscillator = ctx.createOscillator(); oscillator.frequency.value = 440;
          oscillator.connect(destination); oscillator.start();
          (window as any).sourceTrack = destination.stream.getAudioTracks()[0];
          manager.startMainStream(destination.stream); created = true;
        };
        manager.onSessionUpdate = () => start(); start();
        (window as any).stopRetry = startMainStreamRetry({ ready: () => created, mark: () => {}, start });
      }
    });
    await page.waitForFunction(() => Boolean((window as any).auditManager?.userId));
  }
  const [holder, next, output] = pages;
  const audible = () => output.waitForFunction(() => {
    const trace = (window as any).audioTrace;
    return trace.length && trace.at(-1).rms > .02;
  }, undefined, { timeout: 15000 });
  await audible();
  const begin = async () => output.evaluate(() => { (window as any).audioTrace.length = 0; return performance.now(); });
  const finish = async (name: string, since: number, injection: string) => {
    await audible(); await new Promise(r => setTimeout(r, 300));
    const trace = await output.evaluate(() => (window as any).audioTrace as { ms: number; rms: number }[]);
    // Quantized at the receiver's 20ms RMS polling interval; include censored gaps.
    let silentStart: number | null = null, total = 0, longest = 0;
    for (let i = 0; i < trace.length; i++) {
      const row = trace[i];
      if (row.rms <= .02 && silentStart === null) silentStart = i ? trace[i - 1].ms : since;
      if (row.rms > .02 && silentStart !== null) { const span = row.ms - silentStart; total += span; longest = Math.max(longest, span); silentStart = null; }
    }
    assert.equal(silentStart, null, `${name}: receiver remained silent`);
    const result = { case: name, injection, status: 'pass', outageSeconds: total / 1000,
      longestOutageSeconds: longest / 1000, trace, measurement: 'receiver AudioContext RMS <= .02, 20ms polling; browser audio, not physical PA',
      windowSeconds: (trace.at(-1)!.ms - since) / 1000 };
    assert.ok(total / 1000 < 10, `${name}: local recovery exceeded 10s scenario bound`);
    results.push(result);
  };
  let since = await begin();
  const cdp = await holder.context().newCDPSession(holder);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await new Promise(r => setTimeout(r, 1500));
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }); await cdp.detach();
  await finish('tab-throttle', since, 'holder page frozen for 1500ms via CDP; browser audio thread may continue');

  since = await begin();
  await holder.context().setOffline(true);
  // CDP offline does NOT block WebRTC UDP. Add explicit media blackout, labelled as simulation.
  await holder.evaluate(() => { (window as any).sourceTrack.enabled = false; });
  await new Promise(r => setTimeout(r, 1500));
  await holder.context().setOffline(false);
  await holder.evaluate(() => { (window as any).sourceTrack.enabled = true; });
  await finish('wifi-drop-simulation', since, '1500ms signaling offline plus disabled sender track; NOT an actual UDP/ICE outage');

  const nextId = await next.evaluate(() => (window as any).auditManager.userId);
  await next.evaluate(() => { (window as any).permitStream = false; });
  since = await begin();
  await holder.evaluate(to => (window as any).auditManager.sendPluginLockTransfer('mixer', to), nextId);
  await next.waitForFunction(() => (window as any).auditManager.isMainOutOwner);
  await new Promise(r => setTimeout(r, 500));
  await next.evaluate(() => { (window as any).permitStream = true; });
  await finish('mixer-holder-handover', since, 'real server-authorized lock transfer; destination withheld for 500ms; production App 2s retry helper');
  assert.equal(await next.evaluate(() => (window as any).auditManager.isMainOutOwner), true);
  assert.equal(await holder.evaluate(() => (window as any).auditManager.isMainOutOwner), false);
} finally {
  for (const name of ['tab-throttle', 'wifi-drop-simulation', 'mixer-holder-handover']) {
    if (!results.some(r => r.case === name)) results.push({ case: name, status: 'blocked', outageSeconds: null,
      reason: 'baseline audio or preceding scenario did not complete; never interpret as zero downtime' });
  }
  console.log(JSON.stringify({ mode: 'local-staging', hostname: hostname(), at: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), seed: 0,
    browserVersion: browser.version(), results, browserErrors,
    peers: await Promise.all(pages.map(p => p.evaluate(() => ({ userId: (window as any).auditManager?.userId, owner: (window as any).auditManager?.mainOutOwnerId, states: (window as any).auditManager?.getPeerConnectionStates(), details: [...((window as any).auditManager?.peerConnections ?? [])].map(([id,pc]) => ({id, local:pc.localDescription?.type, remote:pc.remoteDescription?.type, gathering:pc.iceGatheringState, localSections:pc.localDescription?.sdp.match(/^m=[^\r\n]+/gm), remoteSections:pc.remoteDescription?.sdp.match(/^m=[^\r\n]+/gm), localCandidates:pc.localDescription?.sdp.match(/^a=candidate:/gm)?.length ?? 0, configTurn:pc.getConfiguration().iceServers?.map(s=>s.urls), localMedia:pc.localDescription?.sdp.match(/^m=/gm)?.length, remoteMedia:pc.remoteDescription?.sdp.match(/^m=/gm)?.length, senders:pc.getSenders().map(s=>s.track?.kind), receivers:pc.getReceivers().map(r=>r.track?.kind)})), iceErrors: (window as any).auditIceErrors, contextState: (window as any).auditContext?.state, hasStream: Boolean((window as any).auditManager?.getMainStream()), trace: (window as any).audioTrace?.slice(-3) })).catch(() => null))) }, null, 2));
  await browser.close(); await hub.close(); hub.io.close(); runtime.stop(); await vite.close();
  localProxy.closeAllConnections(); await new Promise<void>(r => localProxy.close(() => r()));
  await new Promise<void>(r => server.close(() => r()));
}
