import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const directory = '/workspace/work/r9-architecture-data'; mkdirSync(directory, { recursive: true });
const report: Record<string, unknown> = { scope: 'Local real app and production server wiring; four Chromium member contexts and real PA page; injected PCM via public transport, not automatic plugin output, WAN or physical PA proof', status: 'blocked', stages: [] };
const stages = report.stages as unknown[];
const log = createWriteStream(`${directory}/backend-main-app-server.log`);
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', AUDIOMONASTRY_NO_AUTOSTART: '1', AI_MODE: 'off', PORT: '8194' };
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import('./server.ts').then(m=>m.startServer(8194))"], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(log); server.stderr.pipe(log);
let browser: Browser | undefined; let paPage: Page | undefined; const contributorPages: Page[] = []; const contexts: BrowserContext[] = [];
const origin = 'http://127.0.0.1:8194';
const waitFor = async (predicate: () => Promise<boolean>, ms = 30000) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (server.exitCode !== null) throw new Error(`Fixture server exited ${server.exitCode}`); if (await predicate()) return; await new Promise(r => setTimeout(r, 200)); } throw new Error('Timed out waiting for fixture state'); };
async function contributor(page: Page, plugin: string) {
  await page.evaluate(pluginId => (window as any).__webRTCManager.sendPluginLock(pluginId), plugin);
  let lastError = '';
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { return await page.evaluate(async pluginId => {
      const manager = (window as any).__webRTCManager;
      const ticket = await manager.requestBackendMainTicket('contributor', pluginId);
      const url = new URL('/api/main-audio', location.href); url.protocol = 'ws:';
      for (const [key, value] of Object.entries(ticket)) if (typeof value === 'string') url.searchParams.set(key, value);
      const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; (window as any).__proofMain = ws; ws.addEventListener('close', event => { (window as any).__proofClose = { code: event.code, reason: event.reason }; });
      return await new Promise<number>((resolve, reject) => { ws.onmessage = e => { if (typeof e.data === 'string') { const data = JSON.parse(e.data); if (data.type === 'ready') resolve(data.frame); } }; ws.onerror = () => reject(new Error('Main WebSocket failed')); setTimeout(() => reject(new Error('Main ready timeout')), 5000); });
    }, plugin); } catch (e) { lastError = String(e); await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error(`Contributor ${plugin} ticket/socket failed: ${lastError}`);
}
async function send(page: Page, sequence: number, start: number, value: number) {
  await page.evaluate(({ sequence, start, value }) => {
    const frames = 19200, packet = new Uint8Array(16 + frames * 6), view = new DataView(packet.buffer);
    packet.set([66, 77, 65, 49]); view.setUint32(4, sequence, true); view.setUint32(8, start, true); view.setUint32(12, frames, true);
    for (let i = 16; i < packet.length; i += 3) { packet[i] = value & 255; packet[i + 1] = value >> 8 & 255; packet[i + 2] = value >> 16 & 255; }
    (window as any).__proofMain.send(packet);
  }, { sequence, start, value });
}
try {
  await waitFor(async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } });
  stages.push({ stage: 'real server ready', passed: true });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const pages = contributorPages;
  for (let i = 0; i < 4; i++) {
    const context = await browser.newContext(); contexts.push(context); const page = await context.newPage(); pages.push(page);
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.getByRole('button', { name: /Studio betreten/i }).click({ timeout: 45000 });
    await page.waitForFunction(() => !!(window as any).__webRTCManager, undefined, { timeout: 30000 });
  }
  stages.push({ stage: 'four real app contexts opened', passed: true });
  const paContext = await browser.newContext(); contexts.push(paContext);
  await paContext.addInitScript(() => {
    (window as any).__mainBuffers = []; (window as any).__mainCloses = []; (window as any).__lastMainFrame = null; (window as any).__mainMetadata = [];
    const NativeWS = WebSocket;
    window.WebSocket = new Proxy(NativeWS, { construct(target, args) {
      const socket = Reflect.construct(target, args) as WebSocket;
      const url = String(args[0]);
      socket.addEventListener('close', event => { if (url.includes('/api/main-audio')) (window as any).__mainCloses.push({ code: event.code, reason: event.reason }); });
      socket.addEventListener('message', event => { if (url.includes('/api/main-audio') && typeof event.data === 'string') { try { const meta = JSON.parse(event.data); if (meta.type === 'chunk') { (window as any).__lastMainFrame = meta.startFrame + meta.frames; (window as any).__mainMetadata.push(meta); } } catch {} } });
      return socket;
    } });
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer) { const first = this.buffer.getChannelData(0)[0]; let mismatched = 0; for (let channel = 0; channel < this.buffer.numberOfChannels; channel++) { const data = this.buffer.getChannelData(channel); for (let i = 0; i < data.length; i++) if (data[i] !== first) mismatched++; } (window as any).__mainBuffers.push({ rate: this.buffer.sampleRate, channels: this.buffer.numberOfChannels, frames: this.buffer.length, first, last: this.buffer.getChannelData(0)[this.buffer.length - 1], mismatched }); }
      return original.apply(this, args);
    };
  });
  const pa = await paContext.newPage(); paPage = pa; await pa.goto(`${origin}/master-out`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pa.getByText('Backend-Main verbunden', { exact: false }).waitFor({ timeout: 30000 });
  await pa.getByRole('button', { name: /Main-Ausgabe aktivieren/ }).click();
  await pa.getByText('Backend-Main aktiv', { exact: false }).waitFor({ timeout: 30000 });
  stages.push({ stage: 'real PA lossless backend playback active', passed: true });
  const plugins = ['drop', 'song', 'eq', 'sound']; const ready: number[] = [];
  for (let i = 0; i < 4; i++) ready.push(await contributor(pages[i], plugins[i]));
  stages.push({ stage: 'four authenticated human lock holders connected', passed: true, plugins, ready });
  await pa.waitForFunction(() => Number.isInteger((window as any).__lastMainFrame), undefined, { timeout: 10000 });
  await waitFor(async () => (await Promise.all(pages.map(page => page.evaluate(() => !!(window as any).__webRTCManager.isMainOutOwner)))).filter(Boolean).length === 1);
  const members = await Promise.all(pages.map(page => page.evaluate(() => ({ userId: (window as any).__webRTCManager.userId, isMainOutOwner: (window as any).__webRTCManager.isMainOutOwner }))));
  const owners = members.map((member, index) => member.isMainOutOwner ? index : -1).filter(index => index >= 0);
  if (owners.length !== 1 || members.some(member => !member.userId)) throw new Error('Main owner is not uniquely attested');
  const djIndex = owners[0], djId = members[djIndex].userId;
  stages.push({ stage: 'unique actual Main owner identified', passed: true, members, djIndex, djId });
  const continuation = 10000 - (djIndex + 1) * 1000;
  const currentFrame = await pa.evaluate(() => (window as any).__lastMainFrame as number);
  const start = Math.ceil((currentFrame + 96000) / 9600) * 9600;
  stages.push({ stage: 'fresh PA metadata schedules concurrent fixtures', passed: true, freshFrame: currentFrame, start });
  await Promise.all(pages.map((page, i) => send(page, 0, start, (i + 1) * 1000)));
  await new Promise(r => setTimeout(r, 100)); await contexts[djIndex].close();
  await Promise.all(pages.map((page, i) => i === djIndex ? Promise.resolve() : send(page, 1, start + 19200, (i + 1) * 1000)));
  const tolerance = 0.00000015;
  await waitFor(async () => pa.evaluate(({ tolerance, continuation, start }) => {
    const values = (window as any).__mainBuffers as Array<{first:number; mismatched:number}>;
    const first = values.filter(x => x.mismatched === 0 && Math.abs(x.first - 10000 / 8388608) < tolerance);
    const second = values.filter(x => x.mismatched === 0 && Math.abs(x.first - continuation / 8388608) < tolerance);
    const meta = ((window as any).__mainMetadata as Array<{startFrame:number}>).filter(x => x.startFrame >= start && x.startFrame < start + 38400);
    return first.length >= 2 && second.length >= 2 && meta.length === 4;
  }, { tolerance, continuation, start }), 20000);
  const buffers = await pa.evaluate(() => (window as any).__mainBuffers);
  const evidence = buffers.filter((x: { first: number }) => Math.abs(x.first - 10000 / 8388608) < tolerance || Math.abs(x.first - continuation / 8388608) < tolerance);
  if (!evidence.every((x: { rate: number; channels: number; frames: number; mismatched: number }) => x.rate === 96000 && x.channels === 2 && x.frames === 9600 && x.mismatched === 0)) throw new Error('Unexpected decoded PA audio format');
  const metadata = await pa.evaluate(() => (window as any).__mainMetadata);
  const selected = metadata.filter((m: { startFrame: number }) => m.startFrame >= start && m.startFrame < start + 38400);
  if (selected.length !== 4 || selected.some((m: { format: string }) => m.format !== 'flac' && m.format !== 's24le')) throw new Error('Missing output format metadata');
  stages.push({ stage: 'PA scheduled four-source PCM and continued after DJ close', passed: true, start, djIndex, djId, continuation, metadata: selected, buffers: evidence });
  report.status = 'pass';
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); console.error(report.error); if (paPage && !paPage.isClosed()) report.paFailure = await paPage.evaluate(() => ({ text: document.body.innerText, closes: (window as any).__mainCloses, metadata: (window as any).__mainMetadata, buffers: (window as any).__mainBuffers?.slice(-50), audioElements: [...document.querySelectorAll('audio')].map(a => ({ srcObject: !!a.srcObject })) })).catch(String); report.contributors = await Promise.all(contributorPages.map(page => page.isClosed() ? 'closed' : page.evaluate(() => ({ readyState: (window as any).__proofMain?.readyState, close: (window as any).__proofClose })).catch(String))); process.exitCode = 1; }
finally {
  await Promise.allSettled(contexts.map(c => c.close())); await browser?.close(); server.kill('SIGTERM'); log.end();
  writeFileSync(`${directory}/backend-main-app-proof.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
