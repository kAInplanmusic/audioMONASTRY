import { test, expect, type Page } from '@playwright/test';

/**
 * E2E für die neue einheitliche Click/Touch-Audio-Interaktion.
 * Validiert den User-Flow: Library-Sample anklicken → Action Menu →
 * Project Clipboard (gemeinsamer Eintrag) → Send to Track (freies Ziel).
 */

async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator('nav[aria-label="Plugin-Toolbar"]')).toBeVisible({ timeout: 15_000 });
}

async function openLibrary(page: Page): Promise<void> {
  await page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('LIB').first().click();
  await expect(page.getByText('biblioMONK').first()).toBeVisible({ timeout: 10_000 });
}

test('Library-Sample → Action Menu → Project Clipboard → Send to Track', async ({ page }) => {
  await enterStudio(page);
  await openLibrary(page);

  // Preset-Sample anklicken (Mouse Click) → einheitliches Action Menu.
  await page.getByRole('heading', { name: 'TR-909 Classic Kick' }).first().click();
  const menu = page.getByRole('menu', { name: 'Audio-Aktionen' });
  await expect(menu).toBeVisible();

  // In den gemeinsamen Project Clipboard übernehmen.
  await menu.getByRole('menuitem', { name: /Copy to Project Clipboard/ }).click();
  await expect(menu).not.toBeVisible();
  await expect(page.getByText('CLIPBOARD (1)').first()).toBeVisible();

  // Lokalen Upload erzeugen (Audio mit URL) – Cloud-Fallback liefert eine Blob-URL.
  const wavHeader = Buffer.from('52494646'.padEnd(8, '0') + '57415645', 'hex');
  await page.locator('input[type="file"]:visible').first().setInputFiles({
    name: 'e2e-action-test.wav',
    mimeType: 'audio/wav',
    buffer: wavHeader,
  });
  // Neues Sample steht evtl. auf einer späteren Seite → über Suche anzeigen.
  await page.getByPlaceholder('Suche Samples & Musik…').fill('e2e-action-test');
  await page.getByRole('heading', { name: 'e2e-action-test' }).first().waitFor({ timeout: 15_000 });

  // Upload-Sample an einen freien Track senden.
  await page.getByRole('heading', { name: 'e2e-action-test' }).first().click();
  const menu2 = page.getByRole('menu', { name: 'Audio-Aktionen' });
  await expect(menu2).toBeVisible();
  await menu2.getByRole('menuitem', { name: /Send to Track/ }).click();
  await expect(menu2.getByRole('menuitem', { name: /CH 1 · KICK/ })).toBeVisible();
  await menu2.getByRole('menuitem', { name: /CH 1 · KICK/ }).click({ force: true });
  await expect(menu2).not.toBeVisible();

  // Belegter Track darf nicht erneut angeboten werden.
  await page.getByRole('heading', { name: 'e2e-action-test' }).first().click();
  const menu3 = page.getByRole('menu', { name: 'Audio-Aktionen' });
  await menu3.getByRole('menuitem', { name: /Send to Track/ }).click();
  await expect(menu3.getByRole('menuitem', { name: /CH 1 · KICK/ })).toBeDisabled();
});

test.describe('Touch', () => {
  test.use({ hasTouch: true });

  test('Touch-Tap auf ein Library-Sample öffnet dasselbe Action Menu', async ({ page }) => {
    await enterStudio(page);
    await openLibrary(page);

    await page.getByRole('heading', { name: 'TR-909 Classic Kick' }).first().tap();
    await expect(page.getByRole('menu', { name: 'Audio-Aktionen' })).toBeVisible();
  });
});
