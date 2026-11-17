import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { encodeMainFlac } from '../../server/backendMainTransport';

async function main() {
  const bundle = await build({ entryPoints: ['src/core/transport/backendMainClient.ts'], bundle: true, format: 'iife', globalName: 'MainFixture', write: false, platform: 'browser' });
  const flacs = new Map<number, Buffer>();
  const rawPcm = new Map<number, Buffer>();
  for (const rate of [48000, 96000, 192000] as const) {
    const frames = rate / 10, pcm = Buffer.alloc(frames * 6);
    for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) pcm.writeIntLE(((i * 137 + c * 7919) % 16000001) - 8000000, i * 6 + c * 3, 3);
    rawPcm.set(rate, pcm);
    flacs.set(rate, await encodeMainFlac(pcm, rate));
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/client.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); }
    else if (path.startsWith('/pcm/')) { const data = rawPcm.get(Number(path.slice(5))); if (!data) { res.writeHead(404).end(); return; } res.setHeader('Content-Type', 'application/octet-stream'); res.end(data); }
    else if (path.startsWith('/flac/')) { const data = flacs.get(Number(path.slice(6))); if (!data) { res.writeHead(404).end(); return; } res.setHeader('Content-Type', 'audio/flac'); res.end(data); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<script src="/client.js"></script>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage(); await page.goto(`http://localhost:${address.port}/`);
    const browserInfo = await page.evaluate(() => ({ secureContext: isSecureContext, webTransportAvailable: typeof WebTransport !== 'undefined', userAgent: navigator.userAgent }));
    const rows = [];
    for (const format of ['flac', 's24le'] as const) for (const rate of [48000, 96000, 192000]) {
      const row = await page.evaluate(async ({ rate, format }) => {
        const playback = new (window as any).MainFixture.BackendMainPlayback();
        let actualContextRate: number | null = null;
        try {
          await playback.activate(rate); actualContextRate = playback.context.sampleRate;
          const payload = await (await fetch(`/${format === 'flac' ? 'flac' : 'pcm'}/${rate}`)).arrayBuffer();
          const ok = await playback.play({ type: 'chunk', sequence: 0, startFrame: 0, frames: rate / 10, sampleRate: rate, format }, payload);
          const nodes = [...playback.sources] as AudioBufferSourceNode[];
          if (nodes.length !== 1 || !nodes[0].buffer) throw new Error('Scheduled source missing');
          const buffer = nodes[0].buffer;
          let maxAbsDiff = 0, differingSamples = 0;
          for (let c = 0; c < 2; c++) { const samples = buffer.getChannelData(c); for (let i = 0; i < samples.length; i++) { const expected = (((i * 137 + c * 7919) % 16000001) - 8000000) / 8388608; const diff = Math.abs(samples[i] - expected); maxAbsDiff = Math.max(maxAbsDiff, diff); if (diff !== 0) differingSamples++; } }
          return { format, requestedRate: rate, actualContextRate, bufferRate: buffer.sampleRate, frames: buffer.length, channels: buffer.numberOfChannels, scheduled: ok, differingSamples, maxAbsDiff, error: null };
        } catch (error) { return { format, requestedRate: rate, actualContextRate, error: String(error) }; }
        finally { await playback.close(); }
      }, { rate, format });
      rows.push(row);
    }
    console.log(JSON.stringify({ scope: 'Native Chromium AudioContext through bundled BackendMainPlayback fixture (FLAC decodeAudioData and raw PCM24); no actual application, output hardware, or physical latency measurement', browserInfo, rows }, null, 2));
    for (const row of rows) { assert.equal(row.error, null, `rate ${row.requestedRate}`); assert.equal(row.actualContextRate, row.requestedRate); assert.equal(row.bufferRate, row.requestedRate); assert.equal(row.frames, row.requestedRate / 10); assert.equal(row.channels, 2); assert.equal(row.scheduled, true); assert.equal(row.differingSamples, 0); }
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
