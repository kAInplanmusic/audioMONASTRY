import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { attachBackendMainTransport } from '../../server/backendMainTransport';

async function main() {
  const members: Record<string, string> = { dj: 'deck', user2: 'synth', user3: 'drums', user4: 'sampler', pa: 'pa' };
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Main transport fixture</title>'); });
  const transport = attachBackendMainTransport(server, {
    authenticate: req => /(?:^|;\s*)fixture=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null,
    authorize: ({ principal, session, role, plugin }) => session === 'proof' && (role === 'pa' ? principal === 'pa' : role === 'contributor' && members[principal] === plugin && principal !== 'pa'),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const contexts = [];
  const receiver = new WebSocket(`${origin.replace('http:', 'ws:')}/api/main-audio?session=proof&role=pa`, { headers: { cookie: 'fixture=pa' } });
  const chunks: { meta: any; pcm: Buffer }[] = [];
  let pending: any;
  let codecMetadata: any;
  let receiverReady = false;
  let error: Error | undefined;
  receiver.on('error', e => { error = e; });
  receiver.on('message', (data, binary) => {
    try {
      if (!binary) { const value = JSON.parse(data.toString()); if (value.type === 'ready') receiverReady = true; else pending = value; }
      else { assert.ok(pending); if (!codecMetadata) { const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_raw_sample', '-of', 'json', 'pipe:0'], { input: Buffer.from(data as Buffer) }); codecMetadata = JSON.parse(probe.toString()).streams[0]; } const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's24le', '-c:a', 'pcm_s24le', 'pipe:1'], { input: Buffer.from(data as Buffer), maxBuffer: 1024 * 1024 }); chunks.push({ meta: pending, pcm }); pending = undefined; }
    } catch (e) { error = e as Error; }
  });
  const waitUntil = async (predicate: () => boolean, ms = 7000) => { const end = Date.now() + ms; while (!predicate()) { if (error) throw error; if (Date.now() > end) throw new Error('Timed out waiting for proof'); await new Promise(r => setTimeout(r, 20)); } };
  try {
    await waitUntil(() => receiverReady);
    const pages = [];
    for (const user of ['dj', 'user2', 'user3', 'user4']) {
      const context = await browser.newContext(); contexts.push(context);
      await context.addCookies([{ name: 'fixture', value: user, url: origin }]);
      const page = await context.newPage(); pages.push(page); await page.goto(origin);
      await page.evaluate(async ({ user, plugin }) => {
        const ws = new WebSocket(`ws://${location.host}/api/main-audio?session=proof&role=contributor&plugin=${plugin}`); ws.binaryType = 'arraybuffer';
        (window as any).mainSocket = ws;
        (window as any).mainReady = await new Promise((resolve, reject) => { ws.onerror = () => reject(new Error(`connect ${user}`)); ws.onmessage = event => resolve(JSON.parse(String(event.data))); });
      }, { user, plugin: members[user] });
    }
    const ready = await Promise.all(pages.map(p => p.evaluate(() => (window as any).mainReady)));
    const start = Math.ceil((Math.max(...ready.map(r => r.frame)) + 48000) / 9600) * 9600;
    for (let i = 0; i < pages.length; i++) {
      await pages[i].evaluate(({ start, value }) => {
        const frames = 19200, packet = new Uint8Array(16 + frames * 6), view = new DataView(packet.buffer);
        packet.set([66, 77, 65, 49]); view.setUint32(4, 0, true); view.setUint32(8, start, true); view.setUint32(12, frames, true);
        for (let j = 16; j < packet.length; j += 3) { packet[j] = value & 255; packet[j + 1] = (value >> 8) & 255; packet[j + 2] = (value >> 16) & 255; }
        (window as any).mainSocket.send(packet);
      }, { start, value: (i + 1) * 1000 });
    }
    // Allow authorization/enqueue to complete before closing the DJ context.
    await new Promise(r => setTimeout(r, 100));
    await contexts[0].close();
    for (let i = 1; i < pages.length; i++) {
      await pages[i].evaluate(({ start, value }) => {
        const frames = 19200, packet = new Uint8Array(16 + frames * 6), view = new DataView(packet.buffer);
        packet.set([66, 77, 65, 49]); view.setUint32(4, 1, true); view.setUint32(8, start + frames, true); view.setUint32(12, frames, true);
        for (let j = 16; j < packet.length; j += 3) { packet[j] = value & 255; packet[j + 1] = (value >> 8) & 255; packet[j + 2] = (value >> 16) & 255; }
        (window as any).mainSocket.send(packet);
      }, { start, value: (i + 1) * 1000 });
    }
    await waitUntil(() => chunks.some(c => c.meta.startFrame >= start + 28800));
    const selected = chunks.filter(c => c.meta.startFrame >= start && c.meta.startFrame < start + 38400);
    assert.ok(selected.some(c => c.meta.startFrame < start + 19200), 'missing queued four-source audio');
    assert.ok(selected.some(c => c.meta.startFrame >= start + 19200), 'missing three-source continuation');
    for (const { meta, pcm } of selected) {
      assert.equal(meta.sampleRate, 96000); assert.equal(meta.format, 'flac'); assert.equal(meta.frames, 9600); assert.equal(meta.clippedSamples, 0); assert.equal(meta.missingSamples, 0); assert.equal(pcm.length, 9600 * 6);
      const expected = meta.startFrame < start + 19200 ? 10000 : 9000;
      for (let p = 0; p < pcm.length; p += 3) assert.equal(pcm.readIntLE(p, 3), expected);
    }
    assert.equal(codecMetadata.codec_name, 'flac'); assert.equal(codecMetadata.sample_rate, '96000'); assert.equal(codecMetadata.channels, 2); assert.equal(codecMetadata.bits_per_raw_sample, '24');
    console.log(JSON.stringify({ codecMetadata, scope: 'four isolated Chromium contexts using native WebSocket fixture; independent Node PA receiver; no application plugin integration', sampleRate: 96000, format: 'flac', channels: 2, bitDepth: 24, startFrame: start, djClosedBeforePlayback: true, selected: selected.map(({meta}) => meta), verifiedSamplesPerChunk: 19200, fourSourceExpected: 10000, threeSourceExpected: 9000 }, null, 2));
  } finally { receiver.terminate(); await browser.close(); transport.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
