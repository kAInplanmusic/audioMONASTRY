#!/usr/bin/env node
// =============================================================================
// sfu-rtp-helpers.mjs – Gemeinsame SFU-RTP-Testinfrastruktur
// -----------------------------------------------------------------------------
// Wird von `sfu-rtp-run.mjs` und `sfu-rtp-multi-run.mjs` genutzt:
//   * lokaler Static-Server fuer /sfu-rtp-test.html (secure context)
//   * Chromium-Launch mit Fake-Audio-Devices
//   * openRtpPage(): Seite oeffnen und __SFU_RTP_RESULT einsammeln
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

/** Startet den lokalen Static-Server und liefert ihn nach dem Listen zurück. */
export function createSfuRtpServer(localPort) {
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
  return new Promise((resolve) => server.listen(localPort, '127.0.0.1', () => resolve(server)));
}

/** Startet Chromium headless mit Fake-Mic/Device (fuer WebRTC-RTP-Tests). */
export function launchRtpBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}

/**
 * INFRA-HETZNER-027: Baut die Testseiten-URL inkl. Studio-Token.
 *
 * Der SFU-Signaling-Handshake ist fail-closed (server/realtime.ts, P0-Security):
 * ohne gueltigen Studio-Token lehnt der Server den Socket ab ('unauthorized').
 * Der Token kommt aus $STUDIO_ACCESS_TOKEN (in bring-up-fleet.sh aus .env.deploy
 * gesourced) und wird als Query-Parameter an die Testseite gereicht - dort
 * landet er als auth:{token} im socket.io-Handshake (sfu-rtp-entry.js).
 */
export function sfuRtpPageUrl(localPort, baseUrl, { mode, producerId } = {}) {
  const url = new URL(`http://127.0.0.1:${localPort}/sfu-rtp-test.html`);
  url.searchParams.set('server', String(baseUrl ?? '').replace(/\/+$/, ''));
  if (mode) url.searchParams.set('mode', mode);
  if (producerId) url.searchParams.set('producerId', producerId);
  const token = String(process.env.STUDIO_ACCESS_TOKEN ?? '').trim();
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Öffnet die SFU-RTP-Testseite und wartet auf `window.__SFU_RTP_RESULT`.
 * Gibt Kontext, Seite und Ergebnis zurück (Context kann offen bleiben, damit
 * Producer-RTP weiterläuft).
 */
export async function openRtpPage(browser, url, { logConsole = false } = {}) {
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  if (logConsole) page.on('console', (m) => console.log('[browser]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__SFU_RTP_RESULT !== undefined, null, { timeout: 45_000 });
  const result = await page.evaluate(() => window.__SFU_RTP_RESULT);
  return { context, page, result };
}
