// =============================================================================
// fleet-screenshot.mjs – Screenshot des live laufenden Studios (Flotte ready)
// -----------------------------------------------------------------------------
// Loggt sich im Portal ein (Cookies landen im Browser-Context), öffnet die
// Studio-Startseite und speichert einen Full-Page-Screenshot. Die Startseite
// zeigt die aktuelle Version („V. 1.210.001 · HYPERDAW") – der Screenshot ist
// damit der visuelle Nachweis, welcher Stand gerade live läuft.
//
// Env:  PORTAL_URL, ADMIN_USER, ADMIN_PASSWORD, SCREENSHOT_DIR (optional)
// Aufruf (aus fleet-preflight.sh):  node scripts/hetzner/fleet-screenshot.mjs
// =============================================================================
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORTAL_URL = (process.env.PORTAL_URL ?? 'https://anunnakitools.de').replace(/\/+$/, '');
const ADMIN_USER = process.env.ADMIN_USER ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR ?? path.join(root, 'test-results');

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  console.error('ADMIN_USER/ADMIN_PASSWORD fehlen (env).');
  process.exit(1);
}

// 1. Nur schießen, wenn die Flotte wirklich ready ist (sonst fotografieren
//    wir nur die Portal-Loginseite).
const statusRes = await fetch(`${PORTAL_URL}/api/status`);
const status = await statusRes.json().catch(() => ({}));
if (status.state !== 'ready') {
  console.error(`Flotte ist nicht ready (state=${status.state ?? 'unbekannt'}).`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
let ok = false;
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

  // Portal-Login: context.request teilt sich den Cookie-Jar mit dem Browser-Context.
  const loginRes = await context.request.post(`${PORTAL_URL}/api/login`, {
    data: { user: ADMIN_USER, pass: ADMIN_PASSWORD },
  });
  if (!loginRes.ok()) {
    console.error(`Portal-Login fehlgeschlagen (HTTP ${loginRes.status()}).`);
  } else {
    const page = await context.newPage();
    await page.goto(`${PORTAL_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Studio-Startseite: auf den Einstieg warten (falls die App gerade lädt).
    try {
      await page.getByText('Studio betreten').waitFor({ state: 'visible', timeout: 20_000 });
    } catch {
      /* Studio evtl. bereits offen – Screenshot trotzdem machen. */
    }
    await page.waitForTimeout(1_500);

    const title = await page.title();
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const out = path.join(SCREENSHOT_DIR, `fleet-${Date.now()}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`Screenshot gespeichert: ${out}`);
    console.log(`Seitentitel: ${title}`);
    ok = true;
  }
} finally {
  await browser.close();
}
if (!ok) process.exit(1);
