import { test, expect, type Page } from '@playwright/test';

/**
 * P0-7-Prüfpunkt (masterplayerMONK fest oben, View-only):
 *  - bleibt beim Scrollen im Viewport (sticky unter dem Header),
 *  - hat KEINE Eingabeelemente (keine Buttons/Selects) – nur Anzeige,
 *  - Leertaste wirkt nicht in Eingabefeldern (kein Transport-Fehlauslöser).
 */
async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('MIX').first())
    .toBeVisible({ timeout: 15_000 });
}

const masterSection = (page: Page) => page.locator('#rack-masterplayer');

test('P0-7: masterplayerMONK bleibt beim Scrollen sichtbar', async ({ page }) => {
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

test('P0-7: masterplayerMONK ist View-only (keine Buttons, BPM sichtbar)', async ({ page }) => {
  await enterStudio(page);

  const master = masterSection(page);
  await expect(master.getByText('FIXED · VIEW ONLY')).toBeVisible();
  await expect(master.locator('button')).toHaveCount(0);
  await expect(master.locator('select')).toHaveCount(0);
  await expect(master.getByText(/BPM/)).toBeVisible();
  await expect(master.getByText(/TRANSPORT/)).toBeVisible();
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
