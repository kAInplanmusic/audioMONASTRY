import { test, expect } from '@playwright/test';

/**
 * Responsive-/Touch-Matrix: Die App ist laut README für Linux-Laptops +
 * iPhones/iPads im Querformat ausgelegt. Diese Tests prüfen, dass Start und
 * Studio auf Mobil-Viewports laden, ohne horizontal zu overflowen.
 */
test.describe('Responsive/Touch-Matrix', () => {
  test.describe('iPhone 13 Querformat', () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

    test('Studio lädt ohne horizontalen Overflow und Plugin-Toggle funktioniert', async ({ page }) => {
      await page.goto('/');
      await page.getByLabel('audioMONASTRY starten').click();
      await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 20_000 });

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      // Firefox zählt die Breite der vertikalen Scrollbar in scrollWidth mit
      // (Chromium nicht) – 16px Toleranz = Scrollbar, kein echter Overflow.
      expect(overflow).toBeLessThanOrEqual(16);

      await page.getByTitle('SEQ').tap();
      await expect(page.getByTitle('SEQ')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  test.describe('iPad (Gen 7) Querformat', () => {
    test.use({ viewport: { width: 1080, height: 810 }, hasTouch: true, isMobile: true });

    test('Studio lädt ohne horizontalen Overflow', async ({ page }) => {
      await page.goto('/');
      await page.getByLabel('audioMONASTRY starten').click();
      await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 20_000 });

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(16);
    });
  });
});
