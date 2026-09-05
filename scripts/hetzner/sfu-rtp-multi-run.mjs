#!/usr/bin/env node
// =============================================================================
// sfu-rtp-multi-run.mjs – Multi-Peer SFU-RTP-Test (2 Produzenten, N Konsumenten)
// -----------------------------------------------------------------------------
// Ablauf:
//   * P Produzenten-Seiten oeffnen (Fake-Mic, echter SFU-Producer)
//   * C Konsumenten-Seiten oeffnen, die ueber Kreuz konsumieren
//     (consumer i konsumiert producer (i+1) % P)
//   * 1 Echo-Seite (eigener Producer -> eigener Consumer)
//   * alle muessen inbound-rtp bytes > 0 liefern
//
// Aufruf:
//   BASE_URL=http://49.13.65.150 PRODUCERS=2 CONSUMERS=2 \
//     node scripts/hetzner/sfu-rtp-multi-run.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const LOCAL_PORT = Number(process.env.LOCAL_PORT || 8123);
const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const PRODUCERS = Number(process.env.PRODUCERS || 2);
const CONSUMERS = Number(process.env.CONSUMERS || 2);

const server = http.createServer(async (req, res) => {
  try {
    const file = req.url === '/' ? '/sfu-rtp-test.html' : req.url.split('?')[0];
    const data = await readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(LOCAL_PORT, '127.0.0.1', resolve));

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function openPage(url) {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__SFU_RTP_RESULT !== undefined, null, { timeout: 45_000 });
  const result = await page.evaluate(() => window.__SFU_RTP_RESULT);
  return { context, page, result };
}

const summary = { baseUrl: BASE_URL, producers: [], consumers: [], echo: null };
// Produzenten-Kontexte bewusst offen halten (RTP läuft weiter).
const producerContexts = [];

// 1) Produzenten starten (bleiben offen)
for (let i = 0; i < PRODUCERS; i++) {
  const url = `http://127.0.0.1:${LOCAL_PORT}/sfu-rtp-test.html?server=${encodeURIComponent(BASE_URL)}&mode=producer`;
  const { context, result } = await openPage(url);
  producerContexts.push(context);
  if (!result.ok || !result.producerId) {
    console.log(`[producer ${i}] FEHLER: ${JSON.stringify(result)}`);
  }
  summary.producers.push({ index: i, producerId: result.producerId, ok: result.ok, error: result.error });
  console.log(`[producer ${i}] producerId=${result.producerId} ok=${result.ok}`);
}

// 2) Konsumenten ueber Kreuz
for (let i = 0; i < CONSUMERS; i++) {
  const producerIndex = (i + 1) % PRODUCERS;
  const producerId = summary.producers[producerIndex]?.producerId;
  if (!producerId) {
    summary.consumers.push({ index: i, producerIndex, ok: false, error: 'kein producerId' });
    continue;
  }
  const url = `http://127.0.0.1:${LOCAL_PORT}/sfu-rtp-test.html?server=${encodeURIComponent(BASE_URL)}&mode=consumer&producerId=${producerId}`;
  const { context, result } = await openPage(url);
  summary.consumers.push({
    index: i,
    producerIndex,
    producerId,
    ok: result.ok,
    bytesReceived: result.bytesReceived,
    packetsReceived: result.packetsReceived,
    error: result.error,
  });
  console.log(`[consumer ${i}] producer=${producerIndex} bytes=${result.bytesReceived} packets=${result.packetsReceived} ok=${result.ok}`);
  await context.close();
}

// 3) Echo-Test (eigener Producer -> eigener Consumer)
{
  const url = `http://127.0.0.1:${LOCAL_PORT}/sfu-rtp-test.html?server=${encodeURIComponent(BASE_URL)}&mode=echo`;
  const { context, result } = await openPage(url);
  summary.echo = {
    ok: result.ok,
    bytesReceived: result.bytesReceived,
    packetsReceived: result.packetsReceived,
    error: result.error,
  };
  console.log(`[echo] bytes=${result.bytesReceived} packets=${result.packetsReceived} ok=${result.ok}`);
  await context.close();
}

console.log(JSON.stringify(summary, null, 2));
await browser.close();
server.close();

const allOk =
  summary.producers.every((p) => p.ok) &&
  summary.consumers.every((c) => c.ok) &&
  summary.echo?.ok;
process.exit(allOk ? 0 : 1);
