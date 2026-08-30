import { test, expect } from '@playwright/test';

/**
 * Tastatur-Navigation: Skip-Link, Fokus-Falle im Settings-Dialog und
 * Escape-Schließen. Basis für das A11y-Audit (Tastatur-Bedienbarkeit).
 */
test.describe('Tastatur-Navigation', () => {
  test('Skip-Link springt zum Studio-Inhalt', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('audioMONASTRY starten').click();
    await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 20_000 });

    await page.keyboard.press('Tab');
    const skipText = await page.evaluate(() => document.activeElement?.textContent ?? '');
    expect(skipText).toContain('Zum Studio-Inhalt springen');

    await page.keyboard.press('Enter');
    const focusId = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? '');
    expect(focusId).toBe('studio-main');
  });

  test('Settings-Dialog hält den Fokus gefangen und schließt per Escape', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('audioMONASTRY starten').click();
    await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 20_000 });

    await page.getByLabel('Audio / I-O Einstellungen öffnen').click();
    // autoFocus setzt den Fokus auf den Schließen-Button.
    const initial = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? '');
    expect(initial).toBe('Einstellungen schließen');

    // Mehrere Tabs: Fokus muss im Dialog bleiben.
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    const insideDialog = await page.evaluate(() => {
      const el = document.activeElement;
      return !!el && !!el.closest('[role="dialog"]');
    });
    expect(insideDialog).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
