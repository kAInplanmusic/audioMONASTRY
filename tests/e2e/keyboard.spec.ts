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

test.describe('Keyboard-Hotkeys (P1-6): Space, Ctrl/Cmd+1..9, Eingabefelder', () => {
  test('Space togglet den Transport (Play/Stop)', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('audioMONASTRY starten').click();
    await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 20_000 });

    const transport = page.locator('#rack-masterplayer');
    await expect(transport.getByText('STOP', { exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(transport.getByText('PLAY', { exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(transport.getByText('STOP', { exact: true })).toBeVisible();
  });

  test('Ctrl/Cmd+1 togglet das erste Toolbar-Plugin (instrumentMONK)', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('audioMONASTRY starten').click();
    await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 20_000 });

    const firstPlugin = page.locator('nav[aria-label="Plugin-Toolbar"] button[aria-pressed]').first();
    await expect(firstPlugin).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Control+Digit1');
    await expect(firstPlugin).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Control+Digit1');
    await expect(firstPlugin).toHaveAttribute('aria-pressed', 'false');
  });

  test('Hotkeys brechen Eingabefelder nicht (Space tippt Leerzeichen, Ctrl+1 togglet ohne die Eingabe zu verändern)', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 }); // ZWISCHENSPEICHER-Button ist xl-only.
    await page.goto('/');
    await page.getByLabel('audioMONASTRY starten').click();
    await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Zwischenspeicher' }).click();
    const nameInput = page.getByPlaceholder('Name');
    await nameInput.fill('abc');

    const transport = page.locator('#rack-masterplayer');
    await expect(transport.getByText('STOP', { exact: true })).toBeVisible();

    // Space im Eingabefeld: tippt ein Leerzeichen, startet aber NICHT den Transport.
    await page.keyboard.press('Space');
    await expect(nameInput).toHaveValue('abc ');
    await expect(transport.getByText('STOP', { exact: true })).toBeVisible();

    // Ctrl+1 im Eingabefeld: togglet das Plugin, verändert aber die Eingabe nicht.
    const firstPlugin = page.locator('nav[aria-label="Plugin-Toolbar"] button[aria-pressed]').first();
    await page.keyboard.press('Control+Digit1');
    await expect(nameInput).toHaveValue('abc ');
    await expect(firstPlugin).toHaveAttribute('aria-pressed', 'true');
  });
});
