import { BACKEND_MAIN_ADAPTERS, type BackendMainPluginId } from '../../src/core/audio/backendMainAdapter';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';

const directory = process.env.R10_ARTIFACT_DIR ?? '/workspace/work/r10-data/app-proof';
mkdirSync(directory, { recursive: true });
const origin = 'http://127.0.0.1:8196';
const report: { scope: string; status: string; assertions: unknown[]; members?: unknown; error?: string } = {
  scope: 'Four actual Apps, their real UI play actions, automatic source adapters, actual backend and PA page. Fixed WAV input uses the existing player API; no output/packet fixture injection, no AI model request, WAN or physical PA measurement.',
  status: 'fail', assertions: [],
};
const log = createWriteStream(`${directory}/server.log`);
const accepted: Record<string, {packets: number; nonzero: number; energy: number}> = {};
const instrumentation = `
import { BackendMainMixer } from './server/backendMainMixer.ts';
const enqueue = BackendMainMixer.prototype.enqueue;
BackendMainMixer.prototype.enqueue = function (...args) {
  const result = Reflect.apply(enqueue, this, args);
  const bytes = Buffer.from(args[3]); let nonzero = 0, energy = 0;
  for (let i = 0; i < bytes.length; i += 3) { const sample = bytes.readIntLE(i, 3); if (sample) nonzero++; energy += (sample / 8388608) ** 2; }
  if (nonzero) console.log('R10-ACCEPT ' + JSON.stringify({ plugin: args[0], nonzero, energy }));
  return result;
};
await import('./server.ts').then(m => m.startServer(8196));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', instrumentation], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', AUDIOMONASTRY_NO_AUTOSTART: '1', AI_MODE: 'off', PORT: '8196' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(log); server.stderr.pipe(log);
let stdoutPending = '';
server.stdout.on('data', chunk => {
  stdoutPending += String(chunk); const lines = stdoutPending.split('\n'); stdoutPending = lines.pop() ?? '';
  for (const line of lines) if (line.startsWith('R10-ACCEPT ')) {
    const event = JSON.parse(line.slice(11));
    const entry = accepted[event.plugin] ??= { packets: 0, nonzero: 0, energy: 0 };
    entry.packets++; entry.nonzero += event.nonzero; entry.energy += event.energy;
  }
});
const contexts: BrowserContext[] = [], pages: Page[] = [];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
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
  const plugins: BackendMainPluginId[] = process.env.R10_SOURCE_GROUP === 'second'
    ? ['syntisampler', 'drumsampler', 'instru', 'stem'] : ['drop', 'song', 'voice', 'sound'];
  // Put drop on the actual DJ, leaving three genuine non-DJ holders.
  [pages[0], pages[owner]] = [pages[owner], pages[0]];
  [contexts[0], contexts[owner]] = [contexts[owner], contexts[0]];
  const paContext = await browser.newContext(); contexts.push(paContext); await observe(paContext);
  const pa = await paContext.newPage();
  await pa.goto(`${origin}/master-out`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pa.getByText('Backend-Main verbunden', { exact: false }).waitFor({ timeout: 30000 });
  await pa.getByRole('button', { name: /Main-Ausgabe aktivieren/ }).click();
  for (let i = 0; i < 4; i++) {
    const plugin = plugins[i], name = `${plugin}MONK`;
    await pages[i].locator(`#rack-${plugin}`).getByRole('button', { name: new RegExp(`^${name} An$`, 'i') }).click();
    await pages[i].locator(`#rack-${plugin}[data-plugin-mode="ON"][data-plugin-owner="me"]`).waitFor({ timeout: 15000 });
  }
  const tracks = plugins.map(id => { const entry = BACKEND_MAIN_ADAPTERS[id]; if (entry.status !== 'available') throw new Error('Expected real source'); return entry.tapSource; });
  await Promise.all(pages.map((page, i) => page.waitForFunction(async track => {
    const modulePath = '/src/utils/audioEngine.ts'; const { audioEngine } = await import(modulePath);
    return audioEngine.v2LiveSink.isConnected && audioEngine.canLoadTrack(track);
  }, tracks[i], { timeout: 15000 })));
  const inputs = await Promise.all(pages.map((page, i) => page.evaluate(async track => {
    const modulePath = '/src/utils/audioEngine.ts';
    const { audioEngine } = await import(modulePath);
    const url = '/tests/fixtures/audio/golden-1s.wav';
    const allowed = audioEngine.canLoadTrack(track);
    await audioEngine.loadTrackSample(track, url);
    return { track, allowed, loaded: audioEngine.getTrackSampleUrl(track) === url };
  }, tracks[i])));
  console.log('Four source plugins ON, real player input loading recorded', JSON.stringify(inputs));
  await wait(1000);
  await Promise.all(pages.map((page, i) => page.locator(`#rack-${plugins[i]}`).getByRole('button', { name: `${plugins[i]}MONK spielen`, exact: true }).click()));
  await wait(6000);
  const members = await Promise.all(pages.map(snapshot)); report.members = members;
  const four = members.map((member, i) => ({ plugin: plugins[i], mode: 'ON', input: inputs[i], packet: member.packets[plugins[i]] ?? null, accepted: accepted[plugins[i]] ? { ...accepted[plugins[i]] } : null, passed: (accepted[plugins[i]]?.nonzero ?? 0) > 0 }));
  const paBefore = await snapshot(pa);
  report.assertions.push({ test: 'four-real-plugin-contributions', passed: four.every(x => x.passed) && paBefore.buffers.some((x: { energy: number }) => x.energy > 0), roles: four, pa: paBefore });
  console.log('First integration assertion recorded');
  // R10 explicitly asks for Master ON, but does not authorize backend mastering.
  await pages[0].locator('#rack-master').getByRole('button', { name: /^masterMONK An$/i }).click();
  await pages[0].locator('#rack-master[data-plugin-mode="ON"][data-plugin-owner="me"]').waitFor({ timeout: 15000 });
  await wait(1000);
  const dj = await snapshot(pages[0]);
  const acceptedBeforeClose = structuredClone(accepted);
  const beforeClose = (await snapshot(pa)).buffers.length;
  await contexts[0].close(); await wait(2000);
  await Promise.all(pages.slice(1).map((page, i) => page.locator(`#rack-${plugins[i + 1]}`).getByRole('button', { name: `${plugins[i + 1]}MONK spielen`, exact: true }).click()));
  await wait(3000);
  const after = await snapshot(pa), remaining = await Promise.all(pages.slice(1).map(snapshot));
  const continuation = after.buffers.slice(beforeClose).some((x: { energy: number }) => x.energy > 0);
  const acceptedAfterClose = structuredClone(accepted);
  report.assertions.push({ test: 'master-contribution-and-DJ-close', passed: (dj.packets.master?.nonzero ?? 0) > 0 && continuation,
    masterPacket: dj.packets.master ?? null, backendPlaybackContinues: after.buffers.length > beforeClose,
    nonzeroRemainingAudio: continuation, acceptedBeforeClose, acceptedAfterClose, remaining, pa: after });
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
