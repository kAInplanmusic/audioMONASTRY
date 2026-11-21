import { test, expect, type Page } from '@playwright/test';
import { entryButton, STUDIO_NAV, SHORT_TO_NAME } from './helpers/studioNav';
import { newStudioContext } from './helpers/studioAuth';

/**
 * E2E-Plugin-Navigation: Alle 16 MONK-Plugins über die Studio-Navigation
 * ansteuern und auf Sichtbarkeit prüfen.
 *
 * Läuft gegen E2E_BASE_URL (z. B. https://hallerbans.de) oder lokalen
 * Dev-Server (http://localhost:8080).
 *
 * Ersetzt das gelöschte r8-subagents.spec.ts (Playwright API-Inkompatibilität:
 * launchOptions existiert nicht in BrowserContextOptions).
 *
 * @group plugin-navigation
 */

const IGNORED_PAGEERRORS = [
  "Unexpected token 'export'", // Tone.js Worklet-Blob-Polyfill (Chromium)
];

async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await entryButton(page).click();
  await expect(page.locator(STUDIO_NAV).getByTitle('mixerMONK').first())
    .toBeVisible({ timeout: 15_000 });
}

function collectErrors(page: Page): string[] {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => {
    if (!IGNORED_PAGEERRORS.some((needle) => e.message.includes(needle))) {
      pageErrors.push(e.message);
    }
  });
  return pageErrors;
}

test('Alle 16 Plugins sind über die Studio-Navigation erreichbar', async ({ page }) => {
  const errors = collectErrors(page);
  await openStudio(page);

  const nav = page.locator(STUDIO_NAV);
  for (const short of Object.keys(SHORT_TO_NAME)) {
    await expect(nav.getByTitle(SHORT_TO_NAME[short]).first()).toBeVisible();
  }

  expect(errors).toEqual([]);
});

test('4 parallele Browser-Kontexte können gleichzeitig arbeiten (R8-Szenario)', async ({ browser }) => {
  // Alle 16 Plugins – parallele Erreichbarkeitsprüfung
  const roles = Object.keys(SHORT_TO_NAME);
  const results: Array<{ role: string; ok: boolean; error?: string }> = [];

  await Promise.all(
    roles.map(async (short) => {
      const ctx = await newStudioContext(browser, {
        permissions: ['microphone'],
      });
      const pg = await ctx.newPage();
      try {
        await pg.goto('/');
        await entryButton(pg).click();
        await expect(pg.locator(STUDIO_NAV).getByTitle(SHORT_TO_NAME[short]).first())
          .toBeVisible({ timeout: 15_000 });
        results.push({ role: short, ok: true });
      } catch (e) {
        results.push({ role: short, ok: false, error: (e as Error).message });
      } finally {
        await ctx.close();
      }
    })
  );

  const failed = results.filter((r) => !r.ok);
  expect(failed).toEqual([]);
});
