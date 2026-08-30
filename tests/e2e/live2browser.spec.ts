import { test, expect, type Page } from '@playwright/test';
import { chromium } from 'playwright';

/**
 * Live-2-Browser-WebRTC-Test (automatisierter Teil der MASTER_TODO).
 * ----------------------------------------------------------------
 * Zwei UNABHÄNGIGE Chromium-Browserprozesse (jeweils eigener WebRTC-Stack,
 * eigenes Fake-Mikrofon) treten derselben Session bei:
 *   - Offer/Answer + DataChannel: indirekt über die State-Sync-Assertion
 *     (PLUGIN_STATE_UPDATE läuft über den WebRTC-DataChannel).
 *   - Mikrofon: getUserMedia liefert in beiden Browsern einen Audio-Input
 *     (Fake-Device); „Mikrofon nicht verfügbar" darf NICHT auftreten.
 *   - Session: beide sehen SESSION 2/4.
 *
 * Der physische 2-Geräte-Teil (Laptop + iPhone/iPad) bleibt ein Vor-Ort-Test,
 * ist aber funktional durch diesen 2-Prozess-Test abgedeckt.
 */

const FAKE_MEDIA_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 15_000 });
}

test('2 echte Browser: Offer/Answer, State-Sync und Mikrofon', async () => {
  test.setTimeout(90_000);

  const browserA = await chromium.launch({ args: FAKE_MEDIA_ARGS });
  const browserB = await chromium.launch({ args: FAKE_MEDIA_ARGS });

  const errorsA: string[] = [];
  const errorsB: string[] = [];
  const micErrorsA: string[] = [];
  const micErrorsB: string[] = [];

  try {
    const ctxA = await browserA.newContext({ permissions: ['microphone'] });
    const ctxB = await browserB.newContext({ permissions: ['microphone'] });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    pageA.on('pageerror', (e) => errorsA.push(e.message));
    pageB.on('pageerror', (e) => errorsB.push(e.message));
    pageA.on('console', (m) => {
      if (m.text().includes('Mikrofon nicht verfügbar')) micErrorsA.push(m.text());
    });
    pageB.on('console', (m) => {
      if (m.text().includes('Mikrofon nicht verfügbar')) micErrorsB.push(m.text());
    });

    await enterStudio(pageA);
    await enterStudio(pageB);

    // Session: beide Browser sind Mitglieder derselben festen Session.
    await expect(pageA.getByText(/SESSION 2\/4/)).toBeVisible({ timeout: 20_000 });
    await expect(pageB.getByText(/SESSION 2\/4/)).toBeVisible({ timeout: 20_000 });

    // Mikrofon: Fake-Audio-Input ist in beiden Browsern vorhanden.
    await expect
      .poll(async () => (await pageA.evaluate(() => navigator.mediaDevices.enumerateDevices())).some((d) => d.kind === 'audioinput'), { timeout: 10_000 })
      .toBe(true);
    await expect
      .poll(async () => (await pageB.evaluate(() => navigator.mediaDevices.enumerateDevices())).some((d) => d.kind === 'audioinput'), { timeout: 10_000 })
      .toBe(true);

    // Offer/Answer + DataChannel: PLUGIN_STATE_UPDATE (AUTO_AI) muss von A nach B
    // über den WebRTC-DataChannel ankommen (ohne DataChannel keine State-Sync).
    await pageA.getByTitle('SEQ').click();
    await expect(pageB.getByTitle('SEQ')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    await expect(pageA.getByTitle('SEQ')).toHaveAttribute('aria-pressed', 'true');

    // Harte WebRTC-Assertion: Beide Browser haben mindestens einen Peer mit
    // offenem DataChannel und verbundenem ICE (Offer/Answer wirklich gelaufen).
    const hasOpenPeer = (page: Page) =>
      page.evaluate(() => {
        const mgr = (window as any).__webRTCManager;
        const states = mgr?.getPeerConnectionStates?.() ?? {};
        return Object.values(states).some((s: any) => s.datachannel === 'open' && s.ice === 'connected');
      });
    await expect.poll(() => hasOpenPeer(pageA), { timeout: 25_000 }).toBe(true);
    await expect.poll(() => hasOpenPeer(pageB), { timeout: 25_000 }).toBe(true);

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
    expect(micErrorsA).toEqual([]);
    expect(micErrorsB).toEqual([]);

    await ctxA.close();
    await ctxB.close();
  } finally {
    await browserA.close();
    await browserB.close();
  }
});
