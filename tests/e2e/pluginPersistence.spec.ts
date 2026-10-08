import { test, expect } from '@playwright/test';
import { entryButton, modeButton, rackRow, switchPluginOn } from './helpers/studioNav';
import { newStudioContext, resetSession } from './helpers/studioAuth';

/**
 * Beständige Plugins (Betreiber 2026-10-06): „Wenn User 3 aus dem EQ rausgeht
 * und User 4 rein, muss die Einstellung bleiben – für alle Plugins."
 * Der letzte Stand liegt auf dem Server; der nächste Halter startet damit.
 */
test.skip(({ browserName }) => browserName !== 'chromium', 'nur Chromium: Mehrkontext-Session');
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

test.beforeEach(async () => {
  await resetSession();
});

test('EQ: A stellt ein und geht raus – B übernimmt mit genau diesem Stand', async ({ browser }) => {
  test.setTimeout(90_000);
  const ctxA = await newStudioContext(browser);
  const ctxB = await newStudioContext(browser);
  try {
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    for (const page of [pageA, pageB]) {
      await page.goto('/');
      await entryButton(page).click();
      await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });
    }

    // A holt den EQ und hebt das erste Band um 2 dB an.
    await switchPluginOn(pageA, 'eq', 'eqMONK');
    const bandA = rackRow(pageA, 'eq').getByRole('slider', { name: 'EQ-Gain' }).first();
    await bandA.focus();
    for (let i = 0; i < 4; i += 1) await bandA.press('ArrowUp');
    await expect(bandA).toHaveAttribute('aria-valuenow', '2');

    // A geht raus (ON → OFF): der Stand wird sofort gesichert, der EQ ist frei.
    await modeButton(pageA, 'eqMONK').click();
    await expect(rackRow(pageB, 'eq')).toHaveAttribute('data-plugin-owner', 'none', { timeout: 15_000 });

    // B übernimmt – und startet mit A's Stand.
    await switchPluginOn(pageB, 'eq', 'eqMONK');
    const bandB = rackRow(pageB, 'eq').getByRole('slider', { name: 'EQ-Gain' }).first();
    await expect(bandB).toHaveAttribute('aria-valuenow', '2', { timeout: 15_000 });

    // B ändert weiter, geht raus; A holt zurück und sieht B's Stand.
    await bandB.focus();
    await bandB.press('ArrowDown');
    await expect(bandB).toHaveAttribute('aria-valuenow', '1.5');
    await modeButton(pageB, 'eqMONK').click();
    await expect(rackRow(pageA, 'eq')).toHaveAttribute('data-plugin-owner', 'none', { timeout: 15_000 });
    await switchPluginOn(pageA, 'eq', 'eqMONK');
    await expect(rackRow(pageA, 'eq').getByRole('slider', { name: 'EQ-Gain' }).first()).toHaveAttribute('aria-valuenow', '1.5', { timeout: 15_000 });

    // Und nach einem Neuladen ist der Stand immer noch da (Session auf dem Server).
    await modeButton(pageA, 'eqMONK').click();
    await pageB.reload();
    await entryButton(pageB).click();
    await expect(pageB.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });
    await expect(rackRow(pageB, 'eq')).toHaveAttribute('data-plugin-owner', 'none', { timeout: 15_000 });
    await switchPluginOn(pageB, 'eq', 'eqMONK');
    await expect(rackRow(pageB, 'eq').getByRole('slider', { name: 'EQ-Gain' }).first()).toHaveAttribute('aria-valuenow', '1.5', { timeout: 15_000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
