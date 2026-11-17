import { BACKEND_MAIN_ADAPTERS, type BackendMainPluginId } from '../../src/core/audio/backendMainAdapter';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { chromium, type BrowserContext, type Page, type CDPSession } from 'playwright';

const directory = process.env.R15_ARTIFACT_DIR ?? '/workspace/work/r15-data/app-proof';
if (existsSync(`${directory}/result.json`) || existsSync(`${directory}/server.log`)) throw new Error('Choose a fresh evidence directory');
mkdirSync(directory, { recursive: true });
const port = Number(process.env.R15_PORT ?? 8196);
const sourceCount = Number(process.env.R15_SOURCE_COUNT ?? 8);
const durationMs = Number(process.env.R15_DURATION_MS ?? 60000);
if (![4, 6, 8].includes(sourceCount)) throw new Error('R15_SOURCE_COUNT must be 4, 6, or 8');
if (!Number.isFinite(durationMs) || durationMs < 30000) throw new Error('R15_DURATION_MS must be at least 30000');
const origin = `http://127.0.0.1:${port}`;
const report: { scope: string; status: string; assertions: unknown[]; members?: unknown; error?: string } = {
  scope: 'Four actual Apps, their real UI play actions, automatic source adapters, actual backend and PA page. Fixed WAV input uses the existing player API; no output/packet fixture injection, no AI model request, WAN or physical PA measurement.',
  status: 'fail', assertions: [],
};
const log = createWriteStream(`${directory}/server.log`);
const rejects: unknown[] = [];
const processorEvents: any[] = [];
const accepted: Record<string, {packets: number; nonzero: number; energy: number; first: number; last: number}> = {};
const instrumentation = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawnEncoder = childProcess.spawn;
childProcess.spawn = function(...args) {
 const started = Date.now(); const child = Reflect.apply(spawnEncoder, this, args);
 if (String(args[0]).includes('ffmpeg')) child.on('close', code => console.log('R13-ENCODER '+JSON.stringify({wall:Date.now(),ms:Date.now()-started,code})));
 return child;
};
syncBuiltinESMExports();

import { Server } from 'node:http';
const listen = Server.prototype.listen;
Server.prototype.listen = function(...args) { if (typeof args[0] === 'number') { if (typeof args[1] === 'string') args[1] = '127.0.0.1'; else args.splice(1,0,'127.0.0.1'); } return Reflect.apply(listen,this,args); };

import { WebSocket, WebSocketServer } from 'ws';
import { BackendMainWorkerClient } from './server/backendMainWorkerClient.ts';
const upgrade = WebSocketServer.prototype.handleUpgrade;
WebSocketServer.prototype.handleUpgrade = function(req,socket,head,cb) {
 const url=new URL(req.url,'http://localhost');const plugin=url.searchParams.get('plugin');
 return upgrade.call(this,req,socket,head,ws=>{ws.__r15Plugin=plugin;cb(ws);});
};
const wsSend=WebSocket.prototype.send;
WebSocket.prototype.send=function(data,...args){
 if(typeof data==='string'&&this.__r15Plugin){try{const m=JSON.parse(data);if(m.type==='ready')console.log('R15-READY '+JSON.stringify({plugin:this.__r15Plugin,wall:Date.now(),frame:m.frame,rate:m.sampleRate}));}catch{}}
 return Reflect.apply(wsSend,this,[data,...args]);
};
const emit=WebSocket.prototype.emit;
WebSocket.prototype.emit=function(name,...args){
 const b=args[0];if(name==='message'&&args[1]&&this.__r15Plugin&&Buffer.isBuffer(b)&&b.length>=16){const sequence=b.readUInt32LE(4);if(sequence<150||sequence%10===0)console.log('R15-RX '+JSON.stringify({plugin:this.__r15Plugin,sequence,wall:Date.now(),frame:b.readUInt32LE(8)}));}
 return Reflect.apply(emit,this,[name,...args]);
};
const stateRPC=BackendMainWorkerClient.prototype.state;
BackendMainWorkerClient.prototype.state=async function(...args){const startWall=Date.now();const value=await Reflect.apply(stateRPC,this,args);console.log('R15-STATE '+JSON.stringify({startWall,endWall:Date.now(),frame:value.frame}));return value;};
const enqueue=BackendMainWorkerClient.prototype.enqueue;
BackendMainWorkerClient.prototype.enqueue=async function(plugin,sequence,frame,...args){
 const startWall=Date.now();let error,response;try{response=await Reflect.apply(enqueue,this,[plugin,sequence,frame,...args]);return response;}catch(e){error=String(e);throw e;}finally{if(sequence<150||sequence%10===0||error)console.log('R15-IPC '+JSON.stringify({plugin,sequence,frame,startWall,endWall:Date.now(),mixerFrame:response?.frame??this.frame,error}));}
};
await import('./server.ts').then(m => m.startServer(${port}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', instrumentation], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', AUDIOMONASTRY_NO_AUTOSTART: '1', AI_MODE: 'off', BACKEND_MAIN_ENCODING: process.env.R15_ENCODING, BACKEND_MAIN_AUDIT: '1', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(log); server.stderr.pipe(log);
let stdoutPending = '';
server.stdout.on('data', chunk => {
  stdoutPending += String(chunk); const lines = stdoutPending.split('\n'); stdoutPending = lines.pop() ?? '';
  for (const line of lines) {
  if (line.startsWith('R13-REJECT ')) rejects.push(JSON.parse(line.slice(11)));
  if (line.startsWith('R13-PROCESS ')) processorEvents.push(JSON.parse(line.slice(12)));
  if (line.startsWith('R10-ACCEPT ')) {
    const event = JSON.parse(line.slice(11));
    const entry = accepted[event.plugin] ??= { packets: 0, nonzero: 0, energy: 0, first: event.wall, last: event.wall };
    entry.packets++; entry.nonzero += event.nonzero; entry.energy += event.energy; entry.last = event.wall;
  }
  }
});
const contexts: BrowserContext[] = [], pages: Page[] = [];
const profiles: { index: number; session: CDPSession }[] = [];
const cpuSamples: unknown[] = []; let cpuTimer: ReturnType<typeof setInterval> | undefined; const cpuSessions: CDPSession[] = [];
Object.assign(report, { diagnostics: { cpuProfiles: process.env.R15_CPU_PROFILE === '1', foldPanels: process.env.R15_FOLD_PANELS === '1', encoding: process.env.R15_ENCODING ?? 'auto', note: 'Timing instrumentation observes the actual browser pipeline. Folded-panel runs do not prove performance with all panels open.' } });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => Promise<boolean>, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`); if (await predicate()) return; await wait(200); }
  throw new Error('App readiness timeout');
}
async function observe(context: BrowserContext) {
  await context.addInitScript(() => {
    const state = { timing: [] as any[], taps: [] as any[], handshakes: [] as any[], packets: {} as Record<string, { packets: number; frames: number; nonzero: number; energy: number }>, closes: [] as unknown[], buffers: [] as unknown[], errors: [] as string[], outputMetadata: [] as unknown[] };
    (window as any).__r10 = state;
    window.addEventListener('error', event => state.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => state.errors.push(String(event.reason)));
    const NativeWS = WebSocket;
    window.WebSocket = new Proxy(NativeWS, { construct(target, args) {
      const socket = Reflect.construct(target, args) as WebSocket;
      const url = new URL(String(args[0]), location.href);
      if (url.pathname === '/api/main-audio') {
        const plugin = url.searchParams.get('plugin');
        if(plugin){state.handshakes.push({plugin,phase:'created',wall:Date.now()});socket.addEventListener('open',()=>state.handshakes.push({plugin,phase:'open',wall:Date.now()}));socket.addEventListener('message',event=>{if(typeof event.data==='string'){const m=JSON.parse(event.data);if(m.type==='ready')state.handshakes.push({plugin,phase:'ready',wall:Date.now(),...m});}});}
        socket.addEventListener('message', event => {
          if (!plugin && typeof event.data === 'string') { const meta = JSON.parse(event.data); if (meta.type === 'chunk') state.outputMetadata.push({wall:Date.now(),...meta}); }
        });
        socket.addEventListener('close', event => state.closes.push({ plugin, code: event.code, reason: event.reason }));
        if (plugin) {
          const send = socket.send.bind(socket);
          socket.send = data => {
            if (ArrayBuffer.isView(data)) {
              const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
              const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),sequence=view.getUint32(4,true);if(sequence<150||sequence%10===0)state.timing.push({plugin,sequence,frame:view.getUint32(8,true),wall:Date.now(),buffered:socket.bufferedAmount});
              const entry = state.packets[plugin] ??= { packets: 0, frames: 0, nonzero: 0, energy: 0 };
              entry.packets++; entry.frames += (bytes.byteLength - 16) / 6;
              for (let i = 16; i + 2 < bytes.length; i += 3) {
                let sample = bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16;
                if (sample & 0x800000) sample -= 0x1000000;
                if (sample) entry.nonzero++; entry.energy += (sample / 8388608) ** 2;
              }
            }
            return send(data);
          };
        }
      }
      return socket;
    } });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer && location.pathname === '/master-out') {
        let energy = 0;
        for (let c = 0; c < this.buffer.numberOfChannels; c++) for (const x of this.buffer.getChannelData(c)) energy += x * x;
        state.buffers.push({ frames: this.buffer.length, rate: this.buffer.sampleRate, energy, rms: Math.sqrt(energy / (this.buffer.length * this.buffer.numberOfChannels)) });
      }
      return start.apply(this, args);
    };
  });
}
async function snapshot(page: Page) { return page.evaluate(() => ({ ...(window as any).__r10, mainOwner: (window as any).__webRTCManager?.isMainOutOwner, userId: (window as any).__webRTCManager?.userId, isolated: crossOriginIsolated, text: document.body.innerText.slice(-1500) })); }
try {
  await waitFor(async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } });
  for (let i = 0; i < 4; i++) {
    const context = await browser.newContext(); contexts.push(context); await observe(context);
    const page = await context.newPage(); pages.push(page);
    page.on('console', message => { if (message.type() === 'error') log.write(`browser-${i}: ${message.text()}\n`); });
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.getByRole('button', { name: /Studio betreten/i }).click({ timeout: 45000 });
    await page.locator('#rack-drop').waitFor({ timeout: 30000 });
  }
  await waitFor(async () => (await Promise.all(pages.map(p => p.evaluate(() => !!(window as any).__webRTCManager?.isMainOutOwner)))).filter(Boolean).length === 1);
  const owner = (await Promise.all(pages.map(p => p.evaluate(() => !!(window as any).__webRTCManager.isMainOutOwner)))).findIndex(Boolean);
  console.log('Four Apps joined, actual unique DJ found');
  const groups: Record<number, BackendMainPluginId[][]> = {
    4: [['drop'], ['song'], ['drumsampler'], ['instru']],
    6: [['drop','song'], ['drumsampler','syntisampler'], ['instru'], ['voice']],
    8: [['drop','song'], ['drumsampler','syntisampler'], ['instru','voice'], ['sound','stem']],
  };
  const plugins = groups[sourceCount];
  Object.assign(report, { sourceCount, durationMs, plugins });
  // Put drop on the actual DJ, leaving three genuine non-DJ holders.
  [pages[0], pages[owner]] = [pages[owner], pages[0]];
  [contexts[0], contexts[owner]] = [contexts[owner], contexts[0]];
  Object.assign(report, { actors: await Promise.all(pages.map(async (page, index) => ({ index, userId: await page.evaluate(() => (window as any).__webRTCManager?.userId), sources: plugins[index] }))) });
  const paContext = await browser.newContext(); contexts.push(paContext); await observe(paContext);
  const pa = await paContext.newPage();
  await pa.goto(`${origin}/master-out`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pa.getByText('Backend-Main verbunden', { exact: false }).waitFor({ timeout: 30000 });
  await pa.evaluate(async () => {
    const state = (window as any).__r10;
    state.playback = { calls: 0, falseReturns: 0, errors: [], closes: 0, first: null, last: null, states: [] };
    const path = '/src/core/transport/backendMainClient.ts';
    const { BackendMainPlayback } = await import(path);
    const play = BackendMainPlayback.prototype.play, close = BackendMainPlayback.prototype.close;
    BackendMainPlayback.prototype.play = async function (...args: any[]) {
      try {
        const result = await Reflect.apply(play, this, args);
        const now = Date.now(); state.playback.calls++; state.playback.first ??= now; state.playback.last = now;
        if (!result) state.playback.falseReturns++;
        return result;
      } catch (error) { state.playback.errors.push(String(error)); throw error; }
    };
    BackendMainPlayback.prototype.close = async function (...args: any[]) { state.playback.closes++; return Reflect.apply(close, this, args); };
    new MutationObserver(() => { if (document.body.innerText.includes('Ausgabe gestoppt')) state.playback.states.push({ wall: Date.now(), text: document.body.innerText }); }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  for (let i = 0; i < 4; i++) for (const plugin of plugins[i]) {
    await pages[i].locator(`#rack-${plugin}`).getByRole('button', { name: new RegExp(`^${plugin}MONK An$`, 'i') }).click();
    await pages[i].locator(`#rack-${plugin}[data-plugin-mode="ON"][data-plugin-owner="me"]`).waitFor({ timeout: 15000 });
  }
  const tracks = plugins.map(group => group.map(id => { const entry = BACKEND_MAIN_ADAPTERS[id]; if (entry.status !== 'available') throw new Error('Expected real source'); return entry.tapSource; }));
  await Promise.all(pages.map((page, i) => page.waitForFunction(async tracks => {
    const modulePath = '/src/utils/audioEngine.ts'; const { audioEngine } = await import(modulePath);
    return audioEngine.v2LiveSink.isConnected && tracks.every((track: string) => audioEngine.canLoadTrack(track));
  }, tracks[i], { timeout: 30000 })));
  const inputs = await Promise.all(pages.map((page, i) => page.evaluate(async tracks => {
    const modulePath = '/src/utils/audioEngine.ts'; const { audioEngine } = await import(modulePath);
    const url = '/tests/fixtures/audio/golden-1s.wav';
    for (const track of tracks) await audioEngine.loadTrackSample(track, url);
    return tracks.map((track: string) => ({ track, loaded: audioEngine.getTrackSampleUrl(track) === url }));
  }, tracks[i])));
  console.log('Four source plugins ON, real player input loading recorded', JSON.stringify(inputs));
  // Install passive timing after the player modules have loaded and before playback.
  await Promise.all(pages.map(page => page.evaluate(async () => {
    const state = (window as any).__r10;
    const manager=(window as any).__webRTCManager;const ticket=manager.requestBackendMainTicket.bind(manager);manager.requestBackendMainTicket=async(...args)=>{const startWall=Date.now();try{return await ticket(...args);}finally{state.handshakes.push({phase:'ticket',plugin:args[1],startWall,endWall:Date.now()});}};
    state.clocks = []; state.ring = []; state.src = { calls: 0, totalMs: 0, maxMs: 0 };
    const enginePath = '/src/utils/audioEngine.ts'; const { audioEngine } = await import(enginePath);
    const srcPath = '/src/core/audio/backendMainResampler.ts'; const { BackendMainResampler } = await import(srcPath);
    const process = BackendMainResampler.prototype.process;
    BackendMainResampler.prototype.process = function (...args: any[]) {
      const start = performance.now();
      try { return Reflect.apply(process, this, args); }
      finally { const ms = performance.now() - start; state.src.calls++; state.src.totalMs += ms; state.src.maxMs = Math.max(state.src.maxMs, ms); }
    };
    const ringPath = '/src/core/audio/backendMainSourceTap.ts'; const { BackendMainSourceRing } = await import(ringPath);
    const read = BackendMainSourceRing.prototype.read;
    const last: Record<string, number> = {};
    BackendMainSourceRing.prototype.read = function (channel: string, rate: number) {
      const h0=(Number(channel.slice(7))-1)*4;const before=Number(Atomics.load(this.header as Int32Array,h0+2))>>>0;const write=Number(Atomics.load(this.header as Int32Array,h0+1))>>>0;const start=performance.now();
      const block = read.call(this, channel, rate), now = Date.now();
      if(block)state.taps.push({wall:now,channel,rate,frames:block.frameCount,timestamp:block.timestamp,readBefore:before,write,readAfter:Number(Atomics.load(this.header as Int32Array,h0+2))>>>0,readMs:performance.now()-start,nonzero:block.channels.some(c=>c.some(x=>x!==0))});
      if (now - (last[channel] ?? 0) >= 500) {
        last[channel] = now; const h = (Number(channel.slice(7)) - 1) * 4;
        state.ring.push({ wall: now, channel, rate, available: !!block,
          write: Number(Atomics.load(this.header as Int32Array, h + 1)) >>> 0,
          read: Number(Atomics.load(this.header as Int32Array, h + 2)) >>> 0 });
      }
      return block;
    };
    setInterval(() => {
      const context = audioEngine.v2LiveSink.context;
      state.clocks.push({ wall: Date.now(), performance: performance.now(), currentTime: context?.currentTime ?? null,
        nativeRate: context?.sampleRate ?? null, state: context?.state ?? null, src: { ...state.src }, hidden: document.hidden });
    }, 500);
  })));
  if (process.env.R15_CPU_PROFILE === '1') for (let i = 0; i < pages.length; i++) {
    const session = await pages[i].context().newCDPSession(pages[i]);
    await session.send('Profiler.enable'); await session.send('Profiler.start');
    profiles.push({ index: i, session });
  }
  const processorOwners: Record<string, number> = { mixer: 0, master: 0, eq: 1, dsp: 1, effect: 2, spatial: 3 };
  for (const id of ['eq', 'dsp', 'effect', 'spatial', 'master']) {
    const page = pages[processorOwners[id]];
    await page.locator(`#rack-${id}`).getByRole('button', { name: new RegExp(`^${id}MONK An$`, 'i') }).click();
    await page.locator(`#rack-${id}[data-plugin-mode="ON"][data-plugin-owner="me"]`).waitFor({ timeout: 15000 });
  }
  const configs: Record<string, object> = {
    mixer: { sources: Object.fromEntries(plugins.flat().map(id => [id, { gain: 0.4, pan: 0, sendEffect: 1, sendSpatial: 1 }])) },
    eq: { low: 18, mid: -12, high: 12 }, dsp: { cutoff: 250, resonance: 0.8, depth: 1, drive: 0.8, oversampling: 1 },
    effect: { wet: 1, feedback: 0.6, rate: 1, depth: 0.8 }, spatial: { pan: 0.8, width: 0.3 }, master: { gain: 0.4 },
  };
  await wait(1000); // Let newly mounted panels load their authoritative settings.
  const configuredAt = Date.now();
  for (const [id, parameters] of Object.entries(configs)) {
    if (id === 'master') {
      const expand = pages[0].locator('#rack-master').getByRole('button', { name: /^masterMONK aufklappen$/i });
      if (await expand.isVisible()) await expand.click();
      await pages[0].getByLabel('master Main Summenpegel').fill('0.4');
    } else {
      await pages[processorOwners[id]].evaluate(async ({ id, parameters }) => {
        const path = '/src/utils/pluginSettings.ts';
        const { writePluginSettings, flushPluginSettings } = await import(path);
        writePluginSettings(id, parameters, { section: 'backendMain' });
        flushPluginSettings(id);
      }, { id, parameters });
    }
  }
  if (process.env.R15_FOLD_PANELS === '1') {
    for (const page of pages) {
      const buttons = page.locator('section[id^="rack-"] button[aria-label$=" zuklappen"]');
      while (await buttons.count()) await buttons.first().click();
    }
  }
  await wait(1000); // Setup completes before the scored interval; R13 cold-start results remain red.
  await pa.getByRole('button', { name: /Main-Ausgabe aktivieren/ }).click();
  await Promise.all(pages.map((page, i) => page.evaluate(async tracks => {
    const modulePath = '/src/utils/audioEngine.ts'; const { audioEngine } = await import(modulePath);
    for (const track of tracks) audioEngine.v2LiveSink.triggerSample(track, { loop: true, rate: 1, offset: 0 });
  }, tracks[i])));

  for (const page of [...pages,pa]) { const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable',{timeDomain:'threadTicks'});cpuSessions.push(cdp); }
  let cpuBusy=false;
  const sampleCpu=async()=>{if(cpuBusy)return;cpuBusy=true;try{cpuSamples.push({wall:Date.now(),contexts:await Promise.all(cpuSessions.map(async(cdp,index)=>({index,role:index===4?'PA':'source',metrics:(await cdp.send('Performance.getMetrics')).metrics}))) });}catch(error){cpuSamples.push({wall:Date.now(),error:String(error)});}finally{cpuBusy=false;}};
  await sampleCpu();cpuTimer=setInterval(()=>void sampleCpu(),1000);
  const started = Date.now();
  await wait(5000);
  const phaseEvents = processorEvents.slice();
  for (const id of Object.keys(configs)) {
    const evidence = phaseEvents.filter(event => {
      const stage = event.report?.stages?.[id];
      return event.wall >= configuredAt && JSON.stringify(event.snapshot?.[id]?.parameters) === JSON.stringify(configs[id]) && event.snapshot?.[id]?.active && stage?.active && stage.inputEnergy > 0 && Math.abs(stage.outputEnergy - stage.inputEnergy) > 1e-12;
    });
    report.assertions.push({ test: `processor-${id}-changes-audio`, passed: evidence.length > 0, evidence: evidence.slice(0, 3) });
  }
  if (process.env.R15_LIFECYCLE === '1') {
  // Observe an actual OFF transition and subsequent acquisition by another user.
  const offAt = Date.now();
  await pages[1].locator('#rack-eq').getByRole('button', { name: /^eqMONK Aus$/i }).click();
  await pages[2].locator('#rack-eq[data-plugin-mode="OFF"][data-plugin-owner="none"]').waitFor({ timeout: 15000 });
  await wait(5000);
  const offEvents = processorEvents.filter(event => event.wall >= offAt && event.snapshot?.eq?.active === false);
  await pages[2].locator('#rack-eq').getByRole('button', { name: /^eqMONK An$/i }).click();
  await pages[2].locator('#rack-eq[data-plugin-mode="ON"][data-plugin-owner="me"]').waitFor({ timeout: 15000 });
  await wait(5000);
  const onEvents = processorEvents.filter(event => event.wall >= (offEvents[0]?.wall ?? Date.now()) && event.snapshot?.eq?.active === true);
  report.assertions.push({ test: 'eq-off-and-handover', passed: offEvents.length > 0 && onEvents.length > 0, off: offEvents.slice(0, 2), on: onEvents.slice(0, 2) });
  // R5 server attestation and a new human acquisition revoke the generation.
  await pages[2].evaluate(async () => (window as any).__webRTCManager.startPluginDelegation('eq'));
  await pages[2].waitForFunction(() => !!(window as any).__webRTCManager.getPluginDelegation('eq'), null, { timeout: 10000 });
  const grant = await pages[2].evaluate(() => (window as any).__webRTCManager.getPluginDelegation('eq'));
  await pages[1].locator('#rack-eq').getByRole('button', { name: /^eqMONK An$/i }).click();
  await pages[1].locator('#rack-eq[data-plugin-mode="ON"][data-plugin-owner="me"]').waitFor({ timeout: 15000 });
  const validAfter = await pages[2].evaluate(async grant => (window as any).__webRTCManager.validatePluginDelegation(grant, 'eq'), grant);
  report.assertions.push({ test: 'delegation-revoked-by-handover', passed: !!grant?.generationId && validAfter === false, grant, validAfter });
  }
  const remaining = Math.max(0, durationMs - (Date.now() - started));
  await wait(remaining);
  const firsts = plugins.flat().map(id => accepted[id]?.first).filter((x): x is number => typeof x === 'number');
  if (firsts.length === sourceCount) await wait(Math.max(0, Math.max(...firsts) + durationMs + 1000 - Date.now()));
  const members = await Promise.all(pages.map(snapshot)); report.members = members;
  const paResult = await snapshot(pa);
  report.assertions.push({ test: 'real-plugin-contributions', passed: plugins.flat().every(id => (accepted[id]?.nonzero ?? 0) > 0 && accepted[id].last - accepted[id].first >= durationMs && accepted[id].packets >= durationMs / 10) && paResult.buffers.some((x: { energy: number }) => x.energy > 0), inputs, accepted, elapsedMs: Date.now() - started, pa: paResult });
  const playback = paResult.playback;
  report.assertions.push({ test: 'pa-continuity', passed: !!playback && playback.calls > 0 && playback.falseReturns === 0 && playback.errors.length === 0 && playback.closes === 0 && playback.states.length === 0 && paResult.closes.length === 0 && (playback.last - playback.first >= durationMs) && (Date.now() - playback.last < 5000) && !paResult.text.includes('Ausgabe gestoppt'), playback, closes: paResult.closes });
  report.assertions.push({ test: 'source-capture-continuity', passed: members.every((member: any) => member.closes.length === 0 && member.errors.length === 0), evidence: members.map((member: any) => ({ closes: member.closes, errors: member.errors })) });
  Object.assign(report, { processorEvents });
  report.assertions.push({ test: 'no-rejected-packets', passed: rejects.length === 0, rejects });
  report.status = report.assertions.every((x: any) => x.passed) ? 'pass' : 'fail';
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  report.members = await Promise.all(pages.map(page => page.isClosed() ? Promise.resolve('closed') : snapshot(page).catch(String)));
} finally {
  clearInterval(cpuTimer);writeFileSync(`${directory}/browser-cpu.json`,JSON.stringify({scope:'CDP renderer threadTicks TaskDuration CPU; shared audio/GPU/network processes not attributable per context',samples:cpuSamples},null,2));
  // Stop profiling even if an earlier assertion or UI action threw.
  const profileResults = await Promise.allSettled(profiles.map(async ({ index, session }) => {
    const result = await session.send('Profiler.stop');
    writeFileSync(`${directory}/profile-${index}.json`, JSON.stringify(result), { flag: 'wx' });
    await session.detach();
  }));
  Object.assign(report, { processorEvents, rejects, accepted });
  Object.assign(report, { profileResults: profileResults.map((result, i) => ({ index: profiles[i].index, status: result.status, ...(result.status === 'rejected' ? { error: String(result.reason) } : {}) })) });
  await Promise.allSettled(contexts.map(context => context.close())); await browser.close();
  server.kill('SIGTERM');
  await Promise.race([new Promise<void>(resolve => server.once('exit', () => resolve())), wait(10000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  log.end(); writeFileSync(`${directory}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}
