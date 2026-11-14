/** Shared browser owned by this fixture; four actual agent workers attach by CDP. */
import { chromium } from 'playwright';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
const directory = '/workspace/work/r8-data/functional';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const origin = 'http://127.0.0.1:8188';
// PeerConnections can start ICE gathering while the page loads, before Login.
// Require the actual local TURN listener BEFORE creating any browser/page.
let turnReady = false;
for (let attempt = 0; attempt < 60 && !turnReady; attempt++) {
 turnReady = await new Promise<boolean>(resolve => {
  const socket = net.connect(3479, '127.0.0.1');
  const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
  socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  socket.setTimeout(1000, () => finish(false));
 });
 if (!turnReady) await new Promise(r => setTimeout(r, 500));
}
if (!turnReady) throw new Error('Functional setup requires local TCP TURN3479 ready before any peer is created');
writeFileSync(directory+'/turn-ready.json',JSON.stringify({at:new Date().toISOString(),host:'127.0.0.1',port:3479,scope:'TCP listener readiness; actual RTP asserted by roles'}),{mode:0o600});

const allowed = (host: string, port: number) => ['127.0.0.1', 'localhost'].includes(host) && [8188, 3479].includes(port);
const proxy = http.createServer((req, res) => {
  const target = new URL(req.url || '/', origin);
  if (!allowed(target.hostname, Number(target.port))) { res.writeHead(403); res.end(); return; }
  const upstream = http.request(target, { method: req.method, headers: req.headers }, incoming => { res.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(res); });
  upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
});
proxy.on('connect', (req, socket, head) => {
  const target = new URL('http://' + req.url), port = Number(target.port);
  if (!allowed(target.hostname, port)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const upstream = net.connect(port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
});
proxy.on('upgrade', (req, socket, head) => {
  const target = new URL(req.url || '/', origin), port = Number(target.port);
  if (!allowed(target.hostname, port)) { socket.destroy(); return; }
  const upstream = net.connect(port, '127.0.0.1', () => { upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${Object.entries(req.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`); if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket); });
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
});
await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
const port=(proxy.address() as net.AddressInfo).port;
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=9240',`--proxy-server=http://127.0.0.1:${port}`,'--proxy-bypass-list=<-loopback>']});
const roles=['producer','generator','mastering','eq'];
const contexts=[];
for(const role of roles){
 const context=await browser.newContext({viewport:{width:1440,height:1200}});contexts.push(context);
 await context.addCookies([{name:'studio',value:'r8-local-functional',domain:'127.0.0.1',path:'/'}]);
 await context.addInitScript(`
  globalThis.__name = (fn) => fn;
  // TEST network fixture only: preserve the native WebRTC implementation,
  // but install deterministic local TURN before the first auto-joining peer.
  globalThis.r8IceErrors = [];
  const NativePeer = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class R8LocalTurnPeer extends NativePeer {
   constructor(...args) {
    super({ ...args[0], iceServers: [{ urls: 'turn:127.0.0.1:3479?transport=tcp', username: 'local-audit', credential: 'local-audit' }] }, args[1]);
    this.addEventListener('icecandidateerror', event => globalThis.r8IceErrors.push({ code: event.errorCode, text: event.errorText }));
   }
  };
 `);
 await context.route('**/api/webrtc-config**',route=>route.fulfill({json:{iceServers:[{urls:'turn:127.0.0.1:3479?transport=tcp',username:'local-audit',credential:'local-audit'}]}}));
 const page=await context.newPage();await page.goto(`${origin}/?liveAudit=1&r8Role=${role}`);
}
const output=await contexts[0].newPage();await output.goto(`${origin}/master-out?liveAudit=1&r8Role=output`);
writeFileSync(directory+'/browser-ready.json',JSON.stringify({pid:process.pid,origin,cdp:'http://127.0.0.1:9240',roles,networkFixture:'native WebRTC with fixed local TCP TURN before first peer construction; no WAN proof',browserVersion:browser.version(),at:new Date().toISOString()},null,2),{mode:0o600});
let resolveStop:()=>void;const stopped=new Promise<void>(r=>{resolveStop=r;});
process.on('SIGTERM',()=>resolveStop());process.on('SIGINT',()=>resolveStop());
await stopped;await browser.close();proxy.closeAllConnections();await new Promise<void>(r=>proxy.close(()=>r()));
