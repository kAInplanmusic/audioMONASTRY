import { test, expect, type Page } from '@playwright/test';
import { entryButton, STUDIO_NAV, switchPluginOn } from './helpers/studioNav';
import { resetSession } from './helpers/studioAuth';

test.beforeEach(async () => {
  await resetSession();
});

// Nur Chromium: Der Kernfluss ist die Clipboard-Uebernahme der App; in WebKit bleibt die Anzeige 'CLIPBOARD (1)' aus.
// CI-Fund 2026-09-17 (e2e-webkit): 'getByText(CLIPBOARD (1))' blieb unsichtbar.
test.skip(({ browserName }) => browserName !== 'chromium', 'nur Chromium: Clipboard-Uebernahme der App');

/**
 * E2E für die neue einheitliche Click/Touch-Audio-Interaktion.
 * Validiert den User-Flow: Library-Sample anklicken → Action Menu →
 * Project Clipboard (gemeinsamer Eintrag) → Send to Track (freies Ziel).
 */

async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await entryButton(page).click();
  await expect(page.locator(STUDIO_NAV)).toBeVisible({ timeout: 15_000 });
}

async function openLibrary(page: Page): Promise<void> {
  // Header-Icon navigiert nur; die Bedienfläche öffnet der Modus-Button (UI2-P0-002).
  await page.locator(STUDIO_NAV).getByTitle('biblioMONK').first().click();
  await switchPluginOn(page, 'biblio', 'biblioMONK');
}

test('Library-Sample → Action Menu → Project Clipboard → Send to Track', async ({ page }) => {
  await openStudio(page);
  await openLibrary(page);

  // Preset-Sample anklicken (Mouse Click) → einheitliches Action Menu.
  await page.getByRole('heading', { name: 'TR-909 Classic Kick' }).first().click();
  const menu = page.getByRole('menu', { name: 'Audio-Aktionen' });
  await expect(menu).toBeVisible();

  // In den gemeinsamen Project Clipboard übernehmen.
  await menu.getByRole('menuitem', { name: /Copy to Project Clipboard/ }).click();
  await expect(menu).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'CLIPBOARD (1)' }).first()).toBeVisible();

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

  // Upload-Sample an einen Kanal senden wollen.
  await page.getByRole('heading', { name: 'e2e-action-test' }).first().click();
  const menu2 = page.getByRole('menu', { name: 'Audio-Aktionen' });
  await expect(menu2).toBeVisible();
  await menu2.getByRole('menuitem', { name: /Send to Track/ }).click();
  await expect(menu2.getByRole('menuitem', { name: /CH 1 · DROP/ })).toBeVisible();

  // P0-1: Kanaele darf NUR der DJ (mixerMONK-Halter) belegen. UI2-P0-001: der
  // Mixer hat immer genau einen Halter - in dieser Einzelsitzung ist das der
  // einzige Nutzer, die Ziele sind also frei und der Send geht durch.
  await expect(page.locator('#rack-mixer')).toHaveAttribute('data-plugin-owner', 'me');
  const channels = menu2.getByRole('menuitem').filter({ hasText: /^CH \d+ ·/ });
  await expect(channels.first()).toBeVisible();
  expect(await channels.count()).toBeGreaterThan(0);
  await expect(channels.first()).toBeEnabled();
  await expect(channels.first()).not.toContainText('nur DJ / Freigabe');
  await channels.first().click();
  await expect(menu2).not.toBeVisible();
});

test.describe('Touch', () => {
  test.use({ hasTouch: true });

  test('Touch-Tap auf ein Library-Sample öffnet dasselbe Action Menu', async ({ page }) => {
    await openStudio(page);
    await openLibrary(page);

    await page.getByRole('heading', { name: 'TR-909 Classic Kick' }).first().tap();
    await expect(page.getByRole('menu', { name: 'Audio-Aktionen' })).toBeVisible();
  });
});
