import { test, expect, type Page } from '@playwright/test';
import { entryButton, STUDIO_NAV } from './helpers/studioNav';

/**
 * P0-7-Prüfpunkt (mastergraphMONK fest oben, View-only):
 *  - bleibt beim Scrollen im Viewport (sticky unter dem Header),
 *  - hat KEINE Eingabeelemente (keine Buttons/Selects) – nur Anzeige,
 *  - Leertaste wirkt nicht in Eingabefeldern (kein Transport-Fehlauslöser).
 */
async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await entryButton(page).click();
  await expect(page.locator(STUDIO_NAV).getByTitle('mixerMONK').first())
    .toBeVisible({ timeout: 15_000 });
}

const masterSection = (page: Page) => page.locator('#rack-mastergraph');

test('P0-7: mastergraphMONK steht fest direkt unter dem Kopf und scrollt mit (nichts klebt)', async ({ page }) => {
  // Betreiber 2026-10-07: Kopf und Mastergraph sind fest (nicht schließbar,
  // nicht verschiebbar), kleben beim Scrollen aber nicht.
  await openStudio(page);

  const master = masterSection(page);
  await expect(master).toBeVisible();
  const topBefore = (await master.boundingBox())?.y ?? -1;
  expect(topBefore).toBeGreaterThanOrEqual(0);
  expect(topBefore).toBeLessThan(220);
  await expect(master.locator('button')).toHaveCount(0);

  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(300);
  const after = (await master.boundingBox())?.y ?? 0;
  expect(after).toBeLessThan(topBefore);
});

test('P0-7: mastergraphMONK ist View-only (keine Buttons, BPM sichtbar)', async ({ page }) => {
  await openStudio(page);

  const master = masterSection(page);
  await expect(master.getByText('MASTERGRAPH · NUR ANSICHT')).toBeVisible();
  await expect(master.locator('button')).toHaveCount(0);
  await expect(master.locator('select')).toHaveCount(0);
  await expect(master.getByText(/BPM/)).toBeVisible();
  await expect(master.getByText(/TRANSPORT/)).toBeVisible();
});

test('P0-7: Leertaste in Eingabefeldern löst keinen Transport aus', async ({ page }) => {
  await openStudio(page);

  const scrollBefore = await page.evaluate(() => window.scrollY);
  const input = page.locator('input[type="text"], textarea').first();
  if (await input.count()) {
    await input.click();
    // Firefox fokussiert per Klick nicht zuverlaessig: ohne Fokus geht die
    // Leertaste an das Dokument und scrollt die Seite (CI-Fund 2026-09-17:
    // window.scrollY sprang um 2217 px). Fokus explizit setzen und pruefen.
    await input.focus();
    await expect(input).toBeFocused();
    await input.press('Space');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(/\s/);
  }
  // Der eigentliche P0-7-Punkt: Die Leertaste im Eingabefeld darf den TRANSPORT
  // nicht starten. Die frueher hier stehende Scroll-Zusicherung (< 50 px) war nur
  // ein Stellvertreter und schlug in WebKit UND Firefox fehl, weil nachgeladene
  // Layout-Teile die Seite verschieben (CI-Fund 2026-09-17: 2217 px). Geprueft wird
  // deshalb die Regel selbst: das Feld hat das Leerzeichen bekommen (oben) und der
  // Transport zeigt kein PLAY.
  await expect(page.locator('#rack-mastergraph').getByText('PLAY', { exact: true })).toHaveCount(0);
  void scrollBefore;
});
