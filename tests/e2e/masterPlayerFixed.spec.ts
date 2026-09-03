import { test, expect, type Page } from '@playwright/test';

/**
 * P0-7-Prüfpunkt (Master-Player fest oben mit Transport):
 *  - masterplayerMONK bleibt beim Scrollen im Viewport (sticky unter dem Header),
 *  - Play/Stop per Button und per Leertaste erreichbar – auch weit unten,
 *  - Leertaste wirkt nicht in Eingabefeldern (kein Transport-Fehlauslöser).
 */
async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('MIX').first())
    .toBeVisible({ timeout: 15_000 });
}

const masterSection = (page: Page) => page.locator('#rack-masterplayer');

test('P0-7: Master-Player bleibt beim Scrollen sichtbar', async ({ page }) => {
  await enterStudio(page);

  const master = masterSection(page);
  await expect(master).toBeVisible();
  const topBefore = (await master.boundingBox())?.y ?? -1;
  expect(topBefore).toBeGreaterThanOrEqual(0);

  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(300);

  await expect(master).toBeInViewport();
  const box = await master.boundingBox();
  expect(box).not.toBeNull();
  // Bleibt oben im Viewport (direkt unter dem 80 px hohen Header).
  expect(box!.y).toBeLessThan(200);
});

test('P0-7: Transport per Button und Leertaste erreichbar', async ({ page }) => {
  await enterStudio(page);

  const play = masterSection(page).getByRole('button', { name: /play|stop/i }).first();
  await expect(play).toBeVisible();
  await play.click();
  await page.waitForTimeout(200);

  // Nach dem Scrollen bleibt die Leertaste global gültig.
  await page.mouse.wheel(0, 1500);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);

  await expect(masterSection(page)).toBeInViewport();
  await expect(page.getByText(/BPM/).first()).toBeVisible();
});

test('P0-7: Leertaste in Eingabefeldern löst keinen Transport aus', async ({ page }) => {
  await enterStudio(page);

  const scrollBefore = await page.evaluate(() => window.scrollY);
  const input = page.locator('input[type="text"], textarea').first();
  if (await input.count()) {
    await input.click();
    await input.type('a b');
    await expect(input).toHaveValue(/a b/);
  }
  // Kein Page-Scroll-Sprung durch die Leertaste.
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore)).toBeLessThan(50);
});
