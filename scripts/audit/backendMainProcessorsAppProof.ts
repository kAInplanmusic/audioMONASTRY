import { BACKEND_MAIN_ADAPTERS, type BackendMainPluginId } from '../../src/core/audio/backendMainAdapter';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';

const directory = process.env.R12_ARTIFACT_DIR ?? '/workspace/work/r12-data/app-proof';
if (existsSync(`${directory}/result.json`) || existsSync(`${directory}/server.log`)) throw new Error('Choose a fresh evidence directory');
mkdirSync(directory, { recursive: true });
const port = Number(process.env.R12_PORT ?? 8196);
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
import { Server } from 'node:http';
const listen = Server.prototype.listen;
Server.prototype.listen = function(...args) { if (typeof args[0] === 'number') { if (typeof args[1] === 'string') args[1] = '127.0.0.1'; else args.splice(1,0,'127.0.0.1'); } return Reflect.apply(listen,this,args); };
import { BackendMainMixer } from './server/backendMainMixer.ts';
const enqueue = BackendMainMixer.prototype.enqueue;
import { BackendMainProcessors } from './server/backendMainProcessors.ts';
const process = BackendMainProcessors.prototype.process;
let blocks = 0;
BackendMainProcessors.prototype.process = function (...args) {
  const result = Reflect.apply(process,this,args);
  if (++blocks % 5 === 0) console.log('R12-PROCESS '+JSON.stringify({wall:Date.now(),snapshot:args[1],report:this.lastReport}));
  return result;
};
BackendMainMixer.prototype.enqueue = function (...args) {
  let result; try { result = Reflect.apply(enqueue, this, args); } catch(error) { console.log('R12-REJECT '+JSON.stringify({plugin:args[0],error:String(error),wall:Date.now()})); throw error; }
  const bytes = Buffer.from(args[3]); let nonzero = 0, energy = 0;
  for (let i = 0; i < bytes.length; i += 3) { const sample = bytes.readIntLE(i, 3); if (sample) nonzero++; energy += (sample / 8388608) ** 2; }
  if (nonzero) console.log('R10-ACCEPT ' + JSON.stringify({ plugin: args[0], nonzero, energy, wall: Date.now() }));
  return result;
};
await import('./server.ts').then(m => m.startServer(${port}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', instrumentation], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', AUDIOMONASTRY_NO_AUTOSTART: '1', AI_MODE: 'off', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(log); server.stderr.pipe(log);
let stdoutPending = '';
server.stdout.on('data', chunk => {
  stdoutPending += String(chunk); const lines = stdoutPending.split('\n'); stdoutPending = lines.pop() ?? '';
  for (const line of lines) {
  if (line.startsWith('R12-REJECT ')) rejects.push(JSON.parse(line.slice(11)));
  if (line.startsWith('R12-PROCESS ')) processorEvents.push(JSON.parse(line.slice(12)));
  if (line.startsWith('R10-ACCEPT ')) {
    const event = JSON.parse(line.slice(11));
    const entry = accepted[event.plugin] ??= { packets: 0, nonzero: 0, energy: 0, first: event.wall, last: event.wall };
    entry.packets++; entry.nonzero += event.nonzero; entry.energy += event.energy; entry.last = event.wall;
  }
  }
});
const contexts: BrowserContext[] = [], pages: Page[] = [];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => Promise<boolean>, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`); if (await predicate()) return; await wait(200); }
  throw new Error('App readiness timeout');
}
async function observe(context: BrowserContext) {
  await context.addInitScript(() => {
    const state = { packets: {} as Record<string, { packets: number; frames: number; nonzero: number; energy: number }>, closes: [] as unknown[], buffers: [] as unknown[], errors: [] as string[] };
    (window as any).__r10 = state;
    window.addEventListener('error', event => state.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => state.errors.push(String(event.reason)));
    const NativeWS = WebSocket;
    window.WebSocket = new Proxy(NativeWS, { construct(target, args) {
      const socket = Reflect.construct(target, args) as WebSocket;
      const url = new URL(String(args[0]), location.href);
      if (url.pathname === '/api/main-audio') {
        const plugin = url.searchParams.get('plugin');
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
  const plugins: BackendMainPluginId[][] = [['drop','song'],['drumsampler','syntisampler'],['instru','voice'],['sound','stem']];
  // Put drop on the actual DJ, leaving three genuine non-DJ holders.
  [pages[0], pages[owner]] = [pages[owner], pages[0]];
  [contexts[0], contexts[owner]] = [contexts[owner], contexts[0]];
  const paContext = await browser.newContext(); contexts.push(paContext); await observe(paContext);
  const pa = await paContext.newPage();
  await pa.goto(`${origin}/master-out`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pa.getByText('Backend-Main verbunden', { exact: false }).waitFor({ timeout: 30000 });
  await pa.getByRole('button', { name: /Main-Ausgabe aktivieren/ }).click();
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
  await Promise.all(pages.map((page, i) => page.evaluate(async tracks => {
    const modulePath = '/src/utils/audioEngine.ts'; const { audioEngine } = await import(modulePath);
    for (const track of tracks) audioEngine.v2LiveSink.triggerSample(track, { loop: true, rate: 1, offset: 0 });
  }, tracks[i])));
  const started = Date.now();
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
  await wait(5000);
  const phaseEvents = processorEvents.slice();
  for (const id of Object.keys(configs)) {
    const evidence = phaseEvents.filter(event => {
      const stage = event.report?.stages?.[id];
      return event.wall >= configuredAt && JSON.stringify(event.snapshot?.[id]?.parameters) === JSON.stringify(configs[id]) && event.snapshot?.[id]?.active && stage?.active && stage.inputEnergy > 0 && Math.abs(stage.outputEnergy - stage.inputEnergy) > 1e-12;
    });
    report.assertions.push({ test: `processor-${id}-changes-audio`, passed: evidence.length > 0, evidence: evidence.slice(0, 3) });
  }
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
  const remaining = Math.max(0, Number(process.env.R12_DURATION_MS ?? 60000) - (Date.now() - started));
  await wait(remaining);
  const members = await Promise.all(pages.map(snapshot)); report.members = members;
  const paResult = await snapshot(pa);
  report.assertions.push({ test: 'eight-real-plugin-contributions', passed: plugins.flat().every(id => (accepted[id]?.nonzero ?? 0) > 0 && accepted[id].last - accepted[id].first >= Math.max(0, Number(process.env.R12_DURATION_MS ?? 60000) - 5000)) && paResult.buffers.some((x: { energy: number }) => x.energy > 0), inputs, accepted, elapsedMs: Date.now() - started, pa: paResult });
  report.assertions.push({ test: 'no-rejected-packets', passed: rejects.length === 0, rejects });
  report.status = report.assertions.every((x: any) => x.passed) ? 'pass' : 'fail';
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  report.members = await Promise.all(pages.map(page => page.isClosed() ? Promise.resolve('closed') : snapshot(page).catch(String)));
} finally {
  await Promise.allSettled(contexts.map(context => context.close())); await browser.close();
  server.kill('SIGTERM');
  await Promise.race([new Promise<void>(resolve => server.once('exit', () => resolve())), wait(10000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  log.end(); writeFileSync(`${directory}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}
