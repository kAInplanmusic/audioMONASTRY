/** Local browser staging only: actual P2P audio + production signaling/locks. */
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createRealtimeHub } from '../../server/realtime';
import { createSessionRuntime } from '../../server/sessionRuntime';

// No server.ts import: no AI fleet timers, hooks, routes or cloud access.
process.env.NODE_ENV = 'test';
process.env.SESSION_STATE_FILE = 'off';
process.env.ENABLE_SFU = '0';
process.env.LOCAL_TURN_URL = 'turn:127.0.0.1:3479?transport=tcp';
await new Promise<void>((resolve,reject)=>{const socket=net.connect(3479,'127.0.0.1',()=>{socket.destroy();resolve();});socket.once('error',reject);});
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
const directory=resolve(process.env.PRIVATE_MONITOR_PROOF_OUTPUT??'test-results/private-monitor-'+Date.now());
mkdirSync(directory,{recursive:true,mode:0o700});
const pages:import('playwright').Page[]=[],errors:string[]=[];
let report:Record<string,unknown>={scope:'private headphone transport fixture; no B3, WAN, PA or AI inference claim'};
try{
 for(let i=0;i<4;i++){
  const context=await browser.newContext();const page=await context.newPage();pages.push(page);
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript('globalThis.__name=(fn)=>fn');
  await page.goto(base+'/?privateMonitorProof='+i);
  await page.evaluate(async()=>{
   const {refreshIceConfig,rtcConfig}=await import(String('/src/config/webrtc.ts'));await refreshIceConfig();
   const {webRTCManager:manager}=await import(String('/src/utils/WebRTCManager.ts'));
   const {PrivateMonitorTransport}=await import(String('/src/utils/privateMonitorTransport.ts'));
   const ctx=new AudioContext();await ctx.resume();const analyser=ctx.createAnalyser();analyser.fftSize=1024;
   const sink=ctx.createGain();sink.gain.value=0;analyser.connect(sink);sink.connect(ctx.destination);
   const state=window as any;state.manager=manager;state.context=ctx;state.analyser=analyser;state.monitorErrors=[];state.deliveries=0;
   state.monitor=new PrivateMonitorTransport({sendSignal:signal=>manager.sendMonitorSignal(signal),subscribeSignals:listener=>manager.addMonitorSignalListener(listener),getRtcConfiguration:()=>rtcConfig,
    onAudioStream:stream=>{
     state.remoteSource?.disconnect();state.remoteSource=null;state.remoteStream=stream;
     if(!stream)return;
     state.deliveries++;const audio=document.createElement('audio');audio.muted=true;audio.srcObject=stream;document.body.appendChild(audio);void audio.play().catch(e=>state.monitorErrors.push(e.name));
     state.remoteSource=ctx.createMediaStreamSource(stream);state.remoteSource.connect(analyser);
    },onError:error=>state.monitorErrors.push(error.message)});
  });
  await page.waitForFunction(()=>Boolean((window as any).manager?.mainOutOwnerId),undefined,{timeout:15000});
 }
 const inventory=await Promise.all(pages.map(page=>page.evaluate(()=>({userId:(window as any).manager.userId,ownerId:(window as any).manager.mainOutOwnerId}))));
 const members=inventory.map(x=>x.userId),ownerId=inventory[0].ownerId;
 assert.equal(ownerId,members[0]);assert.equal(new Set(members).size,4);
 await pages[0].evaluate(()=>{
  const state=window as any,destination=state.context.createMediaStreamDestination(),oscillator=state.context.createOscillator(),gain=state.context.createGain();
  oscillator.frequency.value=313;gain.gain.value=.15;oscillator.connect(gain);gain.connect(destination);oscillator.start();
  state.fixtureStream=destination.stream;state.oscillator=oscillator;
 });
 for(const page of pages)await page.evaluate(({members,ownerId})=>{const s=window as any;s.monitor.update({userId:s.manager.userId,ownerId,memberIds:members,stream:s.fixtureStream??null});},{members,ownerId});
 for(const page of pages.slice(1))await page.waitForFunction(()=>{const s=window as any;if(!s.remoteStream?.getAudioTracks().length)return false;const values=new Float32Array(1024);s.analyser.getFloatTimeDomainData(values);return values.some(x=>Math.abs(x)>.001);},undefined,{timeout:20000});
 const measurements=await Promise.all(pages.slice(1).map(page=>page.evaluate(async()=>{
  const state=window as any,started=performance.now(),trace:{ms:number;rms:number}[]=[],values=new Float32Array(1024);
  while(performance.now()-started<5000){state.analyser.getFloatTimeDomainData(values);trace.push({ms:performance.now()-started,rms:Math.sqrt(values.reduce((n,v)=>n+v*v,0)/values.length)});await new Promise(r=>setTimeout(r,20));}
  const rows:Record<string,unknown>[]=[];
  for(const peer of state.monitor.peers.values()){const stats=await peer.pc.getStats();stats.forEach(r=>{if(['inbound-rtp','outbound-rtp'].includes(r.type))rows.push(Object.fromEntries(['type','kind','packetsReceived','packetsSent','bytesReceived','bytesSent','totalSamplesReceived','concealedSamples','totalAudioEnergy'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]])));});}
  return {userId:state.manager.userId,durationMs:performance.now()-started,rmsMean:trace.reduce((n,x)=>n+x.rms,0)/trace.length,rmsMin:Math.min(...trace.map(x=>x.rms)),rmsMax:Math.max(...trace.map(x=>x.rms)),samples:trace.length,trace,rows,trackKinds:state.remoteStream.getTracks().map(t=>t.kind),directions:[...state.monitor.peers.values()].flatMap(p=>p.pc.getTransceivers().map(t=>t.direction)),errors:state.monitorErrors};
 })));
 const owner=await pages[0].evaluate(()=>{const s=window as any;const result={peerCount:s.monitor.peers.size,directions:[...s.monitor.peers.values()].flatMap(p=>p.pc.getTransceivers().map(t=>t.direction)),mainOutStreamExists:!!s.manager.getMainStream(),borrowedTrackStates:s.fixtureStream.getAudioTracks().map(t=>t.readyState),errors:s.monitorErrors};s.monitor.dispose();return{...result,borrowedTrackStatesAfterDispose:s.fixtureStream.getAudioTracks().map(t=>t.readyState)};});
 const sources=['src/utils/privateMonitorTransport.ts','src/utils/WebRTCManager.ts','server/monitorSignaling.ts','server/realtime.ts'];
 report={scope:'four local browser contexts, private headphone transport fixed oscillator fixture; not B3, WAN, PA or AI inference',mode:'private-monitor-loopback-proof',hostname:hostname(),at:new Date().toISOString(),commitBase:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceHashes:Object.fromEntries(sources.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')])),browserVersion:browser.version(),inventory,owner,measurements,errors,directory};
 writeFileSync(join(directory,'private-monitor-proof.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({...report,measurements:measurements.map(({trace:_trace,...result})=>result)},null,2));
 assert.equal(owner.peerCount,3);assert.ok(owner.directions.every(x=>x==='sendonly'));assert.equal(owner.mainOutStreamExists,false);
 assert.ok(owner.borrowedTrackStatesAfterDispose.every(x=>x==='live'));
 for(const row of measurements){assert.ok(row.rmsMean>0);assert.ok(row.durationMs>=5000);assert.ok(row.rows.some(x=>x.type==='inbound-rtp'&&Number(x.packetsReceived)>0));assert.deepEqual(row.trackKinds,['audio']);assert.ok(row.directions.every(x=>x==='recvonly'));assert.deepEqual(row.errors,[]);}
 assert.deepEqual(errors,[]);
} catch(error){writeFileSync(join(directory,'failure.json'),JSON.stringify({error:error instanceof Error?error.stack:String(error),errors,report},null,2),{mode:0o600});throw error;}
finally{
 await browser.close();await hub.close();hub.io.close();runtime.stop();await vite.close();
 localProxy.closeAllConnections();await new Promise<void>(r=>localProxy.close(()=>r()));
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
}
