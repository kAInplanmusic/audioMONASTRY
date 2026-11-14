import { BACKEND_MAIN_ADAPTERS, type BackendMainPluginId } from '../../src/core/audio/backendMainAdapter';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { chromium, type BrowserContext, type Page, type CDPSession } from 'playwright';

const directory = process.env.R11_ARTIFACT_DIR ?? '/workspace/work/r11-data/run1';
mkdirSync(directory, { recursive: true });
if (existsSync(`${directory}/server.log`) || existsSync(`${directory}/result.json`)) throw new Error('Choose a fresh R11_ARTIFACT_DIR; historical evidence must not be overwritten');
const port = Number(process.env.R11_PORT ?? 8196);
const origin = `http://127.0.0.1:${port}`;
const report: { scope: string; status: string; assertions: unknown[]; members?: unknown; error?: string } = {
  scope: 'R11 passive capture, browser scheduler, SRC and server enqueue diagnosis. Existing real V2 player uses fixed WAV input. No PA receiver, WAN, model inference or runtime fix.',
  status: 'fail', assertions: [],
};
const log = createWriteStream(`${directory}/server.log`);
const instrumentation = `
import { BackendMainMixer } from './server/backendMainMixer.ts';
const enqueue = BackendMainMixer.prototype.enqueue;
BackendMainMixer.prototype.enqueue = function (...args) {
  const wall = Date.now(), mixer = this.frame;
  try {
    const result = Reflect.apply(enqueue, this, args);
    if (args[1] % 10 === 0) console.log('R11-ENQUEUE ' + JSON.stringify({wall, plugin:args[0], sequence:args[1], input:args[2], mixer, durationMs:Date.now()-wall}));
    return result;
  } catch(error) { console.log('R11-REJECT '+JSON.stringify({wall,plugin:args[0],sequence:args[1],input:args[2],mixer,error:String(error)})); throw error; }
};
await import('./server.ts').then(m => m.startServer(${port}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', instrumentation], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', AUDIOMONASTRY_NO_AUTOSTART: '1', AI_MODE: 'off', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
Object.assign(report,{cpuBefore:readFileSync('/sys/fs/cgroup/cpu.stat','utf8'),cpuMax:readFileSync('/sys/fs/cgroup/cpu.max','utf8')});
server.stdout.pipe(log); server.stderr.pipe(log);
const contexts: BrowserContext[] = [], pages: Page[] = [];
const profiles: CDPSession[] = [];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => Promise<boolean>, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`); if (await predicate()) return; await wait(200); }
  throw new Error('App readiness timeout');
}
async function observe(context: BrowserContext) {
  await context.addInitScript(() => {
    const state = { packets: {} as Record<string, { packets: number; frames: number; nonzero: number; energy: number }>, closes: [] as unknown[], buffers: [] as unknown[], errors: [] as string[], handshakes: [] as unknown[] };
    (window as any).__r10 = state;
    window.addEventListener('error', event => state.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => state.errors.push(String(event.reason)));
    const NativeWS = WebSocket;
    window.WebSocket = new Proxy(NativeWS, { construct(target, args) {
      const socket = Reflect.construct(target, args) as WebSocket;
      const url = new URL(String(args[0]), location.href);
      if (url.pathname === '/api/main-audio') {
        const plugin = url.searchParams.get('plugin');
        state.handshakes.push({phase:'created',plugin,wall:Date.now()});
        socket.addEventListener('open',()=>state.handshakes.push({phase:'open',plugin,wall:Date.now()}));
        socket.addEventListener('message',event=>{if(typeof event.data==='string'){const m=JSON.parse(event.data);if(m.type==='ready')state.handshakes.push({phase:'ready',plugin,wall:Date.now(),frame:m.frame,rate:m.sampleRate});}});
        socket.addEventListener('close', event => state.closes.push({ plugin, code: event.code, reason: event.reason }));
        if (plugin) {
          const send = socket.send.bind(socket);
          socket.send = data => {
            if (ArrayBuffer.isView(data)) {
              const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
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

  });
}
async function snapshot(page: Page) { return page.evaluate(() => ({ ...(window as any).__r10, mainOwner: (window as any).__webRTCManager?.isMainOutOwner, userId: (window as any).__webRTCManager?.userId, isolated: crossOriginIsolated, text: document.body.innerText.slice(-1500) })); }
try {
  await waitFor(async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } });
  const plugins = (process.env.R11_PLUGINS ?? 'drop,song,syntisampler,drumsampler').split(',') as BackendMainPluginId[];
  for (let i=0;i<plugins.length;i++) {
    const context=await browser.newContext();contexts.push(context);await observe(context);
    const page=await context.newPage();pages.push(page);
    page.on('console',m=>{if(m.type()==='error')log.write(`browser-${i}: ${m.text()}\n`);});
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:/Studio betreten/i}).click();
    await page.locator('#rack-drop').waitFor();
    await page.evaluate(async () => {
      const state=(window as any).__r10;state.capture=[];state.longTasks=[];state.timers=[];state.network=[];state.src=[];state.clocks=[];
      const captureMarks=new WeakMap<object,number>();
      const enginePath='/src/utils/audioEngine.ts';const {audioEngine}=await import(enginePath);
      setInterval(()=>state.clocks.push({wall:Date.now(),context:audioEngine.v2LiveSink.context?.currentTime}),500);
      const srcPath='/src/core/audio/backendMainResampler.ts';const {BackendMainResampler}=await import(srcPath);const process=BackendMainResampler.prototype.process;
      BackendMainResampler.prototype.process=function(...args:any[]){const begin=performance.now();state.currentCaptureWall=captureMarks.get(args[0][0]);const result=Reflect.apply(process,this,args);state.src.push({wall:Date.now(),ms:performance.now()-begin,frames:args[1]});return result;};
      new PerformanceObserver(list=>{for(const e of list.getEntries())state.longTasks.push({wall:Date.now(),start:e.startTime,duration:e.duration});}).observe({entryTypes:['longtask']});
      let last=performance.now();setInterval(()=>{const now=performance.now();state.timers.push({wall:Date.now(),gap:now-last,hidden:document.hidden});last=now;},100);
      const path='/src/core/audio/backendMainSourceTap.ts';const {BackendMainSourceRing}=await import(path);
      const read=BackendMainSourceRing.prototype.read;
      BackendMainSourceRing.prototype.read=function(channel:any,rate:any){const block=read.call(this,channel,rate);if(block){captureMarks.set(block.channels[0],Date.now());const h=(Number(channel.slice(7))-1)*4;state.capture.push({wall:Date.now(),perf:performance.now(),channel,rate,sourceFrame:block.timestamp*rate,frames:block.frameCount,write:Number(Atomics.load(this.header as Int32Array,h+1))>>>0,read:Number(Atomics.load(this.header as Int32Array,h+2))>>>0,hidden:document.hidden,ctx:audioEngine.v2LiveSink.context?.currentTime,meters:audioEngine.v2LiveSink.getMeterValues()});}return block;};
      const send=WebSocket.prototype.send;
      WebSocket.prototype.send=function(data:any){if(ArrayBuffer.isView(data)&&data.byteLength>=16){const view=new DataView(data.buffer,data.byteOffset,data.byteLength);if(view.getUint32(0,true)===0x31414d42&&view.getUint32(4,true)%10===0)state.network.push({wall:Date.now(),sequence:view.getUint32(4,true),frame:view.getUint32(8,true),captureWall:state.currentCaptureWall,buffered:this.bufferedAmount});}return send.call(this,data);};
    });
  }
  const tracks=plugins.map(id=>{const e=BACKEND_MAIN_ADAPTERS[id];if(e.status!=='available')throw Error('No source');return e.tapSource;});
  for(let i=0;i<pages.length;i++)await pages[i].locator(`#rack-${plugins[i]}`).getByRole('button',{name:new RegExp(`^${plugins[i]}MONK An$`,'i')}).click();
  await Promise.all(pages.map((p,i)=>p.waitForFunction(async track=>{const path='/src/utils/audioEngine.ts';const {audioEngine}=await import(path);return audioEngine.canLoadTrack(track)&&audioEngine.v2LiveSink.isConnected;},tracks[i])));
  await Promise.all(pages.map((p,i)=>p.evaluate(async track=>{const path='/src/utils/audioEngine.ts';const {audioEngine}=await import(path);await audioEngine.loadTrackSample(track,'/tests/fixtures/audio/golden-1s.wav');return track;},tracks[i])));
  if(process.env.R11_BARRIER){const folder=process.env.R11_BARRIER;mkdirSync(folder,{recursive:true});writeFileSync(`${folder}/${port}`,'ready');await waitFor(async()=>[8251,8252,8253,8254].every(p=>existsSync(`${folder}/${p}`)),90000);}
  if(process.env.R11_PROFILE==='1')for(const page of pages){const session=await page.context().newCDPSession(page);await session.send('Profiler.enable');await session.send('Profiler.start');profiles.push(session);}
  Object.assign(report,{signalStartWall:Date.now(),cpuSignalStart:readFileSync('/sys/fs/cgroup/cpu.stat','utf8')});
  await Promise.all(pages.map((p,i)=>p.evaluate(async track=>{const path='/src/utils/audioEngine.ts';const {audioEngine}=await import(path);audioEngine.v2LiveSink.triggerSample(track,{loop:true,rate:1,offset:0});},tracks[i])));
  await wait(Number(process.env.R11_DURATION_MS??12000));
  for(let i=0;i<profiles.length;i++){const result=await profiles[i].send('Profiler.stop');writeFileSync(`${directory}/profile-${i}.json`,JSON.stringify(result));}
  Object.assign(report,{cpuAfter:readFileSync('/sys/fs/cgroup/cpu.stat','utf8')});
  report.members=await Promise.all(pages.map(snapshot));report.status='diagnostic';
  if(process.env.R11_RELEASE_OTHERS==='1'){
    Object.assign(report,{releaseWall:Date.now()});
    await Promise.all(contexts.slice(1).map(context=>context.close()));
    await wait(10000);
    Object.assign(report,{afterRelease:await snapshot(pages[0]),cpuAfterRelease:readFileSync('/sys/fs/cgroup/cpu.stat','utf8')});
  }
} catch(error){report.error=String(error);process.exitCode=1;}
finally {
  await Promise.allSettled(contexts.map(c=>c.close()));await browser.close();server.kill('SIGTERM');
  await Promise.race([new Promise<void>(r=>server.once('exit',()=>r())),wait(10000)]);if(server.exitCode===null)server.kill('SIGKILL');
  log.end();writeFileSync(`${directory}/result.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,directory}));
}
