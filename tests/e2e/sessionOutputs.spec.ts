import { test, expect, type Page } from '@playwright/test';
import { entryButton, openStudioMenu } from './helpers/studioNav';
import { newStudioContext, resetSession } from './helpers/studioAuth';

/**
 * Session-Ausgänge (Betreiber 2026-10-06): „1–4 Nutzer, die die UI gestreamt
 * bekommen, ein Main-Ausgang Sound und ein Main-Ausgang Visuals."
 * Jeder Nutzer meldet sein Format und seine Auflösung, PA und Beamer melden
 * ihren Zustand; es gibt genau einen Main-Ausgang je Art.
 */
test.skip(({ browserName }) => browserName !== 'chromium', 'nur Chromium: Mehrkontext + Mobil-Emulation');
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

test.beforeEach(async () => {
  await resetSession();
});

async function enter(page: Page): Promise<void> {
  await page.goto('/');
  await entryButton(page).click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });
}

test('4 UI-Plätze + genau ein Main Audio + genau ein Main Visual (zweites Gerät abgewiesen)', async ({ browser }) => {
  test.setTimeout(120_000);
  const pc = await newStudioContext(browser, { viewport: { width: 1440, height: 900 } });
  const phone = await newStudioContext(browser, { viewport: { width: 852, height: 393 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const pa = await newStudioContext(browser);
  const beamer = await newStudioContext(browser, { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  const beamer2 = await newStudioContext(browser, { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  try {
    const pcPage = await pc.newPage();
    await enter(pcPage);
    const phonePage = await phone.newPage();
    await enter(phonePage);
    await (await pa.newPage()).goto('/master-out');
    const beamerPage = await beamer.newPage();
    await beamerPage.goto('/visual-out');

    await openStudioMenu(pcPage);
    await pcPage.getByRole('button', { name: 'Session-Ausgänge' }).click();
    const panel = pcPage.getByRole('dialog', { name: 'Session-Ausgänge' });
    await expect(panel.getByTestId('endpoint-user-1')).toContainText('du', { timeout: 15_000 });
    await expect(panel.getByTestId('endpoint-user-1')).toContainText('PC/Laptop · 1440×900');
    await expect(panel.getByTestId('endpoint-user-2')).toContainText('Handy quer · 2556×1179', { timeout: 15_000 });
    await expect(panel.getByTestId('endpoint-user-3')).toContainText('frei');
    await expect(panel.getByTestId('endpoint-user-4')).toContainText('frei');
    // PA und Beamer zählen nicht als Nutzer, sind aber verbunden.
    await expect(panel.getByTestId('endpoint-sound-status')).not.toHaveText('nicht verbunden', { timeout: 15_000 });
    await expect(panel.getByTestId('endpoint-visual-status')).toContainText('Bildschirm 1920×1080', { timeout: 15_000 });

    // Genau EIN Main-Ausgang Bild: ein zweites Gerät wird abgewiesen, das erste bleibt.
    const beamer2Page = await beamer2.newPage();
    await beamer2Page.goto('/visual-out');
    await expect(beamer2Page.getByTestId('output-busy')).toBeVisible({ timeout: 15_000 });
    await expect(beamerPage.getByTestId('output-busy')).toHaveCount(0);
    await expect(panel.getByTestId('endpoint-visual-status')).toContainText('Bildschirm 1920×1080', { timeout: 15_000 });
    await expect(pcPage.getByRole('button', { name: 'Session-Ausgänge' })).toContainText('2/4');
  } finally {
    for (const ctx of [pc, phone, pa, beamer, beamer2]) await ctx.close().catch(() => undefined);
  }
});
