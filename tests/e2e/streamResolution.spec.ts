import { test, expect, type Page } from '@playwright/test';
import { entryButton } from './helpers/studioNav';
import { newStudioContext, resetSession } from './helpers/studioAuth';

/**
 * Stream-Auflösung (Betreiber 2026-10-06): „Ein eigener Stream kann eine eigene
 * Auflösung haben." Der Beamer (/visual-out, Ghostuser 6) meldet seinen
 * Bildschirm über den Server; der Sender rendert den Visual-Stream in DIESER
 * Auflösung (Auto) oder in einer festen – nicht in der seines eigenen Geräts.
 */
test.skip(({ browserName }) => browserName !== 'chromium', 'nur Chromium: Mehrkontext + Canvas-Renderer');

test.beforeEach(async () => {
  await resetSession();
});

const canvasSize = (page: Page) =>
  page.getByTestId('visual-canvas').evaluate((c) => ({ w: (c as HTMLCanvasElement).width, h: (c as HTMLCanvasElement).height }));

test('Beamer meldet seine Auflösung, der Stream folgt ihr – unabhängig vom Sendergerät', async ({ browser }) => {
  test.setTimeout(90_000);
  const beamer = await newStudioContext(browser, { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  const host = await newStudioContext(browser, { viewport: { width: 1440, height: 900 } });
  try {
    const beamerPage = await beamer.newPage();
    await beamerPage.goto('/visual-out');
    await expect(beamerPage.getByTestId('visual-out-screen')).toHaveText(/1920×1080/);

    const hostPage = await host.newPage();
    await hostPage.goto('/');
    await entryButton(hostPage).click();
    await expect(hostPage.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });
    await hostPage.getByLabel('Visual-Liveshow öffnen').click();

    // Auto: Größe vom Beamer (1280×720 @1.5x = 1920×1080), nicht 1440×900 des Senders.
    await expect(hostPage.getByTestId('stream-size')).toHaveText('1920×1080 · vom Beamer', { timeout: 15_000 });
    await expect.poll(() => canvasSize(hostPage)).toEqual({ w: 1920, h: 1080 });

    // Feste Wahl: Hochkant 9:16 – auch vom Querformat-PC aus.
    await hostPage.getByLabel('Stream-Auflösung').selectOption('vertical-1080');
    await expect(hostPage.getByTestId('stream-size')).toHaveText('1080×1920 · fest');
    await expect.poll(() => canvasSize(hostPage)).toEqual({ w: 1080, h: 1920 });

    // Beamer geht: Auto fällt auf den Standard zurück.
    await hostPage.getByLabel('Stream-Auflösung').selectOption('auto');
    await beamer.close();
    await expect(hostPage.getByTestId('stream-size')).toHaveText('1920×1080 · Standard', { timeout: 15_000 });
  } finally {
    await beamer.close().catch(() => undefined);
    await host.close();
  }
});
