import { test, expect } from '@playwright/test';

/**
 * Visuelle Regression (A/B-Baseline): Playwright `toHaveScreenshot` mit
 * committeten Baselines (tests/e2e/__screenshots__).
 *
 * Baselines aktualisieren:
 *   npx playwright test visual.spec.ts --update-snapshots
 *
 * Animationen werden für stabile Pixel-Vergleiche deaktiviert.
 *
 * Hinweis: Baselines gelten nur für den LOKALEN Dev-Server. Gegen entfernte
 * Instanzen (BASE_URL) wird der visuelle Vergleich übersprungen.
 */
test.skip(!!process.env.BASE_URL, 'Visuelle Baselines nur gegen den lokalen Dev-Server.');
test('Start-Screen Baseline', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await expect(page).toHaveScreenshot('01-start-screen.png', {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });
});

test('Studio Baseline (Mixer + Modul-Grid)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('MIX')).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveScreenshot('02-studio.png', {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });
});
