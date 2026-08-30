#!/usr/bin/env node
// =============================================================================
// sfu-rtp-run.mjs – Echter SFU-RTP-Pfadtest via Playwright/Chromium
// -----------------------------------------------------------------------------
// Startet Chromium mit Fake-Audio-Device. Die Testseite wird von localhost
// geladen (secure context fuer WebRTC), das Signaling/der Medienpfad laeuft
// gegen BASE_URL (Hetzner-Instanz). Dort muss SIGNALING_ALLOWED_ORIGINS=*
// gesetzt sein.
//
// Aufruf:
//   BASE_URL=http://49.13.65.150 node scripts/hetzner/sfu-rtp-run.mjs
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

// Lokaler Static-Server: Die Testseite laeuft auf localhost (secure context),
// das Signaling geht an BASE_URL (Hetzner-SFU).
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
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage();
page.on('console', (m) => console.log('[browser]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`http://127.0.0.1:${LOCAL_PORT}/sfu-rtp-test.html?server=${encodeURIComponent(BASE_URL)}`);
await page.waitForFunction(() => window.__SFU_RTP_RESULT !== undefined, null, { timeout: 45_000 });
const result = await page.evaluate(() => window.__SFU_RTP_RESULT);

console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
process.exit(result.ok ? 0 : 1);
