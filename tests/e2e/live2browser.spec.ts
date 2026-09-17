import { test, expect, type Page } from '@playwright/test';
import { chromium } from 'playwright';
import { newStudioContext } from './helpers/studioAuth';
import { navButton } from './helpers/studioNav';

// Nur Chromium: Der Spec startet bewusst ZWEI eigene Chromium-Prozesse (eigener WebRTC-Stack, eigenes Fake-Mikrofon); im WebKit-Job fehlt die Chromium-Executable.
// CI-Fund 2026-09-17 (e2e-webkit): 'Executable doesn't exist at .../chromium-...'.
test.skip(({ browserName }) => browserName !== 'chromium', 'nur Chromium: startet explizit zwei Chromium-Prozesse');

/**
 * Live-2-Browser-WebRTC-Test (automatisierter Teil der offenen Aufgaben (MASTERTODOENDE.json)).
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

async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 15_000 });
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
    // Studio-Auth: der Signalisierungs-Server verlangt den Token aus dem
    // `studio`-Cookie. Ohne ihn weist er den zweiten Kontext mit 401
    // 'unauthorized' ab und der Test sieht nie SESSION 2/4 - genau das war der
    // Fehler (live gemessen 2026-09-17: '[B] Signaling connection failed:
    // unauthorized'). collab.spec.ts machte es richtig; die Regel liegt jetzt als
    // Helfer in tests/e2e/helpers/studioAuth.ts.
    const ctxA = await newStudioContext(browserA, { permissions: ['microphone'] });
    const ctxB = await newStudioContext(browserB, { permissions: ['microphone'] });
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

    await openStudio(pageA);
    await openStudio(pageB);

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
    // Falsche Erwartung korrigiert (2026-09-17): die gespiegelte Navigation wird
    // NICHT als aria-current in Bs eigener Nav markiert - aria-current zeigt die
    // EIGENE Ansicht. Der Server relayt die Fremd-Navigation als Remote-Badge
    // ("<userId>->eq", nur ab xl-Viewport sichtbar), genau wie collab.spec.ts es
    // prueft. Zuvor lief die Zusicherung deshalb gegen ein fremdes Element
    // ("Received: ''").
    await navButton(pageA, 'EQ').click();
    await expect(
      pageB.getByText(/u[a-z0-9]+→eq$/),
      'Client B zeigt die gespiegelte eqMONK-Navigation nicht an',
    ).toBeVisible({ timeout: 15_000 });
    // Sanity: A selbst bekommt die eigene Navigation nicht als Remote-Badge.
    await expect(pageA.getByText(/u[a-z0-9]+→eq$/)).toHaveCount(0);

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
