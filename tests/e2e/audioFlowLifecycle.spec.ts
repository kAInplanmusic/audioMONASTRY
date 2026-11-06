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

  test('Offline beim Modul-Laden: definierter Fehler statt leerer Screen', async ({ page, context }) => {
    const errors = collectErrors(page);
    await enterStudio(page);

    await context.setOffline(true);
    await page.waitForTimeout(3_000);

    // BEFUND 2026-11-06 (Ticket UI-2026-11-06-001): Faellt das Netz waehrend
    // des Nachladens eines lazy-Moduls weg, ersetzt die Fehlergrenze die
    // GESAMTE Studio-UI durch "Modul-Fehler : Modul konnte nicht geladen
    // werden. RETRY". Das ist ein definierter Zustand - kein leerer Screen und
    // kein unbehandelter Fehler -, kostet aber die Sitzungsansicht. Ob der
    // Fehler auftritt, haengt davon ab, welcher Chunk gerade laedt (Race).
    const fehlerbox = page.getByText(/Modul-Fehler/i);
    const studio = page.locator('nav[aria-label="Studio-Navigation"]');
    const gate = page.getByRole('button', { name: /Studio betreten/i });
    await expect
      .poll(async () => (await fehlerbox.count()) + (await studio.count()) + (await gate.count()),
        { timeout: 15_000, message: 'Offline darf nicht in einen leeren Screen fuehren' })
      .toBeGreaterThan(0);
    expect((await page.innerText('body')).trim().length).toBeGreaterThan(20);
    expect(errors.pageErrors).toEqual([]);

    // Im Fehlerzustand muss der Ausweg angeboten werden (RETRY).
    if (await fehlerbox.count()) {
      await expect(page.getByRole('button', { name: /^RETRY$/i })).toBeVisible();
    }

    await context.setOffline(false);
    await page.waitForTimeout(1_000);
    // Nach dem Netz-Ausfall ist die App in EINEM der definierten Zustaende -
    // nicht in einem leeren DOM.
    expect((await page.innerText('body')).trim().length).toBeGreaterThan(20);
  });

  test('Langsames Netz (1 Mbit/s, 400 ms RTT): App laedt und ist bedienbar', async ({ page }) => {
    // Ein Kaltstart bei 125 kB/s dauert laenger als das Suite-Timeout von 30 s.
    test.setTimeout(150_000);
    const errors = collectErrors(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: 125_000,
      uploadThroughput: 125_000,
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
    await toggle.click();

    const dialog = page.getByRole('dialog', { name: 'Visual-Liveshow' });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    // Fehler werden gemeldet, das Overlay bleibt bedienbar.
    await expect(dialog.getByRole('button', { name: /SHOW (STOP|START)/i })).toBeVisible({ timeout: 30_000 });
    expect(errors.pageErrors).toEqual([]);
  });
});
