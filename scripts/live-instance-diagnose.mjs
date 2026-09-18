/**
 * Diagnose: was liefert die ECHTE Instanz an den Browser? (COLLAB-P0-002)
 * =====================================================================
 * Oeffnet E2E_BASE_URL mit Studio-Cookie, startet das Studio, sammelt
 * Konsolenfehler/Seitenfehler und dumpt, was im Session-Bereich steht.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8080';

const tokenFromEnv = () => {
  const fromEnv = (process.env.STUDIO_ACCESS_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    const line = env.split('\n').find((l) => l.startsWith('STUDIO_ACCESS_TOKEN='));
    return line ? line.slice('STUDIO_ACCESS_TOKEN='.length).trim() : '';
  } catch { return ''; }
};

const main = async () => {
  const token = tokenFromEnv();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (token) await context.addCookies([{ name: 'studio', value: token, url: BASE }]);
  const page = await context.newPage();
  const errors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 160)));
  page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url().slice(0, 90)} ${r.failure()?.errorText}`));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  console.log('Titel:', await page.title());
  const start = page.getByLabel('audioMONASTRY starten');
  console.log('Start-Button vorhanden:', await start.count());
  if (await start.count()) await start.first().click();
  await page.getByTitle('mixerMONK').first().waitFor({ timeout: 30_000 }).catch(() => console.log('mixerMONK nicht sichtbar'));
  await page.waitForTimeout(4000);

  const badge = await page.locator('header [role=status]').allInnerTexts().catch(() => []);
  console.log('Status-Badges:', JSON.stringify(badge));
  const sessionText = await page.getByText(/SESSION/).allInnerTexts().catch(() => []);
  console.log('SESSION-Texte:', JSON.stringify(sessionText));
  const socket = await page.evaluate(() => {
    const w = window;
    return {
      hasIo: typeof w.io !== 'undefined',
      webRTC: Boolean(w.__webRTCManager),
      socketConnected: w.__webRTCManager?.socket?.connected ?? null,
      userCount: w.__webRTCManager?.sessionPeers?.length ?? null,
    };
  }).catch((e) => ({ fehler: String(e).slice(0, 120) }));
  console.log('Socket/WebRTC:', JSON.stringify(socket));
  console.log('Konsolenfehler:', errors.slice(0, 6));
  console.log('Fehlgeschlagene Requests:', failed.slice(0, 6));
  // Zweiter Kontext (wie im Spec): zaehlt die Session hoch?
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (token) await ctxB.addCookies([{ name: 'studio', value: token, url: BASE }]);
  const pageB = await ctxB.newPage();
  await pageB.goto(BASE, { waitUntil: 'domcontentloaded' });
  const startB = pageB.getByLabel('audioMONASTRY starten');
  if (await startB.count()) await startB.first().click();
  await pageB.getByTitle('mixerMONK').first().waitFor({ timeout: 30_000 }).catch(() => {});
  await pageB.waitForTimeout(4000);
  console.log('B SESSION-Texte:', JSON.stringify(await pageB.getByText(/SESSION/).allInnerTexts().catch(() => [])));
  console.log('A SESSION-Texte (nach B):', JSON.stringify(await page.getByText(/SESSION/).allInnerTexts().catch(() => [])));
  await browser.close();
};

main().catch((e) => { console.error('Diagnose fehlgeschlagen:', e); process.exit(1); });
