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
import { createSfuRtpServer, launchRtpBrowser, openRtpPage } from './sfu-rtp-helpers.mjs';

const LOCAL_PORT = Number(process.env.LOCAL_PORT || 8123);
const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

const server = await createSfuRtpServer(LOCAL_PORT);
const browser = await launchRtpBrowser();
const { result } = await openRtpPage(
  browser,
  `http://127.0.0.1:${LOCAL_PORT}/sfu-rtp-test.html?server=${encodeURIComponent(BASE_URL)}`,
  { logConsole: true },
);

console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();
process.exit(result.ok ? 0 : 1);
