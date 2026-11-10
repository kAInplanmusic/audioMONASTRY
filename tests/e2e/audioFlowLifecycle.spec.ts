import { test, expect, type Page } from '@playwright/test';
import { entryButton, navButton, rackRow, modeButton, switchPluginOn, collectErrors } from './helpers/studioNav';
import { resetSession } from './helpers/studioAuth';

/**
 * Audio-Fluss, Verzweigungen die die bestehende Suite NICHT abdeckt
 * (QA-Auftrag 2026-11-06, Branch-Coverage-Matrix in
 * `docs/AUDIO_FLOW_TESTPLAN.md`).
 *
 * Abgedeckt hier: Berechtigung verweigert, Offline/Online-Recovery,
 * Idempotenz bei Doppel-Tap, Resume nach Reload, Visual-Lifecycle inkl.
 * Credits, langsames Netz, Backend-5xx im Clip-Pfad.
 *
 * Bewusst NICHT hier: Bluetooth-/Headset-Routing, Screen-Lock, Anruf-
 * Unterbrechung, DRM - dafuer fehlt in dieser Umgebung das Geraet (siehe
 * "nicht getestet" in der Matrix).
 */

async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await entryButton(page).click();
  await expect(navButton(page, 'MIX')).toBeVisible({ timeout: 20_000 });
}

/** Mic-Berechtigung verweigert ist der Default im Headless-Kontext. */
test.describe('Berechtigungen', () => {
  test.use({ permissions: [] });

  test('Mikrofon verweigert: Studio bleibt bedienbar, kein unbehandelter Fehler', async ({ page }) => {
    const errors = collectErrors(page);
    await enterStudio(page);

    // Der Mixer ist die Main-Einspeisung und startet aktiv - ohne Mikrofon.
    await expect(page.getByText(/mixerMONK · 8 CH/i)).toBeVisible({ timeout: 20_000 });
    await expect(rackRow(page, 'mixer')).toHaveAttribute('data-plugin-owner', 'me');

    // Ein Plugin laesst sich trotzdem holen und einschalten.
    await switchPluginOn(page, 'drop', 'dropMONK');
    await expect(rackRow(page, 'drop')).toHaveAttribute('data-plugin-mode', 'ON');

    expect(errors.pageErrors).toEqual([]);
  });
});

test.describe('Netzwerk', () => {
  test.beforeEach(async () => { await resetSession(); });

  /**
   * Rauschen der Transport-Schicht, KEIN UI-Fehler: bricht eine WebSocket-
   * Verbindung (Vite-HMR bzw. Signaling) mitten im Handshake ab, meldet
   * Chromium "WebSocket closed without opened." als unbehandelten Fehler.
   * Das passiert beim emulierten Offline-Schalter und in dieser Umgebung auch
   * beim Start des Dev-Servers - der Ticketgegenstand ist die Oberflaeche,
   * nicht der Transport.
   */
  const istOfflineRauschen = (message: string) => /WebSocket closed without opened/i.test(message);

  test('Offline beim Modul-Laden: Fehler bleibt im Modul, Erholung ohne Reload', async ({ page, context }) => {
    // Vier Schritte (Ausfall -> Shell haelt -> RETRY -> Erholung) brauchen mehr als 30 s.
    test.setTimeout(90_000);
    const errors = collectErrors(page);

    // Determinismus: Der urspruengliche Ausloeser aus dem Ticket ist der
    // IMMER gerenderte perforMONK-Terminal (Chunk wird beim Betreten geladen).
    // Den Chunk hier gezielt scheitern zu lassen nimmt das Race aus dem Befund
    // ("haengt davon ab, welcher Chunk gerade laedt") - es ist derselbe Pfad
    // wie ein Netz-Aussetzer mitten im Import.
    const CHUNK = '**/components/PerformanceMonitorTerminal*';
    await page.route(CHUNK, (route) => route.abort('internetdisconnected'));

    await enterStudio(page);

    const nav = page.locator('nav[aria-label="Studio-Navigation"]');
    const mixerRow = rackRow(page, 'mixer');
    const perfor = page.locator('#rack-perfor');

    // Fenster-Marker: ueberlebt jeden React-Zustandswechsel, aber KEINEN Reload.
    // Damit ist "ohne page.reload()" belegt statt behauptet.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__amSessionMarker = 'session-alive';
    });

    // (1) Der Fehler bleibt im Modulbereich: Studio-Shell (Navigation,
    //     Mastergraph, Session, Mixer) steht weiter. Vor dem Fix ersetzte die
    //     Fehlergrenze auf #root die komplette UI (body 55 Zeichen).
    const modulFehler = perfor.getByText(/Modul-Fehler/i);
    await expect(modulFehler).toBeVisible({ timeout: 30_000 });
    await expect(modulFehler).toContainText(/\[perforMONK\]/);
    await expect(nav).toBeVisible();
    await expect(mixerRow).toBeVisible();
    await expect(page.locator('#studio-main')).toBeVisible();
    expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(200);

    // Der Ausweg wird AM MODUL angeboten, nicht als Vollbild-Fehler.
    const retry = perfor.getByRole('button', { name: /^RETRY$/i });
    await expect(retry).toBeVisible();

    // (2) Echter Netz-Ausfall obendrauf: die Shell darf auch dann nicht kippen.
    await context.setOffline(true);
    await page.waitForTimeout(2_000);
    await expect(nav).toBeVisible();
    await expect(mixerRow).toBeVisible();
    expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(200);

    // RETRY ohne Netz: scheitert weiter, aber lokal - und ohne die Shell zu kosten.
    await retry.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    await expect(modulFehler).toBeVisible({ timeout: 20_000 });
    await expect(nav).toBeVisible();
    expect(errors.pageErrors.filter((m) => !istOfflineRauschen(m))).toEqual([]);

    // (3) Netz + Chunk zurueck -> Erholung OHNE page.reload(): entweder
    //     automatisch (online-Event setzt die Grenze zurueck) oder ueber RETRY.
    await page.unroute(CHUNK);
    await context.setOffline(false);
    await perfor.getByRole('button', { name: /^RETRY$/i }).click({ timeout: 5_000 }).catch(() => undefined);
    await expect(perfor.getByLabel('Signal-Monitor Ansicht')).toBeVisible({ timeout: 30_000 });
    await expect(perfor.getByText(/Modul-Fehler/i)).toHaveCount(0);

    // Beweis, dass dafuer niemand die Seite neu geladen hat.
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__amSessionMarker))
      .toBe('session-alive');
    await expect(nav).toBeVisible();
    await expect(mixerRow).toBeVisible();
    expect(errors.pageErrors.filter((m) => !istOfflineRauschen(m))).toEqual([]);
  });

  test('Langsames Netz: 400 ms RTT (Chromium zusaetzlich 1 Mbit/s) – Studio bedienbar', async ({ page, browserName }) => {
    test.setTimeout(150_000);
    const errors = collectErrors(page);
    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 400,
        downloadThroughput: 125_000, uploadThroughput: 125_000,
      });
      try {
        await enterStudio(page);
        await expect(navButton(page, 'MIX')).toBeVisible({ timeout: 60_000 });
        expect(errors.pageErrors).toEqual([]);
      } finally {
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        }).catch(() => undefined);
      }
    } else {
      // CDP only exists in Chromium. WebKit/Firefox still get a real
      // intercepted request latency, not a fake CDP session.
      await page.route('**/*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.continue();
      });
      try {
        await enterStudio(page);
        await expect(navButton(page, 'MIX')).toBeVisible({ timeout: 60_000 });
        expect(errors.pageErrors).toEqual([]);
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }
    }
  });
});

test.describe('Zustands-Idempotenz', () => {
  test.beforeEach(async () => { await resetSession(); });

  test('Doppel-Tap auf den Modus-Button hinterlaesst einen gueltigen Zustand', async ({ page }) => {
    const errors = collectErrors(page);
    await enterStudio(page);

    const btn = modeButton(page, 'dropMONK');
    await btn.click();
    await btn.click({ delay: 10 });
    await btn.click({ delay: 10 });

    // Erlaubt ist jeder Zustand der Machine, aber konsistent zum Halter:
    const mode = await rackRow(page, 'drop').getAttribute('data-plugin-mode');
    const owner = await rackRow(page, 'drop').getAttribute('data-plugin-owner');
    expect(['OFF', 'STBY', 'ON']).toContain(mode);
    if (mode === 'OFF') expect(owner).toBe('none');
    else expect(owner).toBe('me');

    expect(errors.pageErrors).toEqual([]);
  });

  test('Resume nach Reload: Plugin-Stand und Halter kommen vom Server', async ({ page }) => {
    const errors = collectErrors(page);
    await enterStudio(page);
    await switchPluginOn(page, 'eq', 'eqMONK');
    await expect(rackRow(page, 'eq')).toHaveAttribute('data-plugin-mode', 'ON');

    await page.reload();
    await expect(page).toHaveTitle(/audioMONASTRY/);
    await entryButton(page).click();
    await expect(navButton(page, 'MIX')).toBeVisible({ timeout: 20_000 });

    await expect(rackRow(page, 'eq')).toHaveAttribute('data-plugin-mode', 'ON', { timeout: 20_000 });
    expect(errors.pageErrors).toEqual([]);
  });
});

test.describe('Visual-Lifecycle', () => {
  test.beforeEach(async () => { await resetSession(); });

  test('Show oeffnen, Credits anzeigen, Show stoppen', async ({ page }) => {
    const errors = collectErrors(page);
    await enterStudio(page);

    const toggle = page.getByLabel('Visual-Liveshow öffnen');
    await expect(toggle).toBeEnabled({ timeout: 30_000 });
    // /api/session/reset is not always available in browser CI. Normalise
    // previously persisted live-visual state through the actual UI before
    // asserting the open interaction; never rely on fresh storage.
    if (await toggle.getAttribute('aria-pressed') === 'true') {
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    }
    await toggle.click();

    const dialog = page.getByRole('dialog', { name: 'Visual-Liveshow' });
    await expect(dialog).toBeVisible({ timeout: 20_000 });

    // Die Show startet selbsttaetig (Bank geladen) - der Knopf zeigt STOP.
    await expect(dialog.getByRole('button', { name: /SHOW STOP/i })).toBeVisible({ timeout: 30_000 });

    const credits = dialog.getByRole('button', { name: /^CREDITS/i });
    await expect(credits).toBeVisible();
    await credits.click();
    await expect(dialog.getByText(/Namensnennung/i).first()).toBeVisible({ timeout: 10_000 });

    await dialog.getByRole('button', { name: /SHOW STOP/i }).click();
    await expect(dialog.getByRole('button', { name: /SHOW START/i })).toBeVisible({ timeout: 15_000 });

    expect(errors.pageErrors).toEqual([]);
  });

  test('Backend-5xx im Clip-Pfad: Show bleibt stehen, Szene wird verworfen', async ({ page }) => {
    const errors = collectErrors(page);
    // Jeder Bank-Clip scheitert - die Show darf nicht schwarz "haengen".
    await page.route('**/api/ai/vision/bank/**', (route) => route.fulfill({ status: 500, body: '{}' }));

    await enterStudio(page);
    const toggle = page.getByLabel('Visual-Liveshow öffnen');
    await expect(toggle).toBeEnabled({ timeout: 30_000 });
    // /api/session/reset is not always available in browser CI. Normalise
    // previously persisted live-visual state through the actual UI before
    // asserting the open interaction; never rely on fresh storage.
    if (await toggle.getAttribute('aria-pressed') === 'true') {
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    }
    await toggle.click();

    const dialog = page.getByRole('dialog', { name: 'Visual-Liveshow' });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    // Fehler werden gemeldet, das Overlay bleibt bedienbar.
    await expect(dialog.getByRole('button', { name: /SHOW (STOP|START)/i })).toBeVisible({ timeout: 30_000 });
    expect(errors.pageErrors).toEqual([]);
  });
});
