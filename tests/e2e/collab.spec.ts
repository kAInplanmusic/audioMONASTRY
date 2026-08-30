import { test, expect, type Page } from '@playwright/test';

/**
 * Collaboration-Smoke (DCT-113 Basis): Mehrere Browser-Kontexte treten dem
 * Studio bei und die Session-Mitgliederzahl wird über Socket.io-Signaling
 * korrekt gespiegelt (SESSION n/4 bzw. SESSION VOLL bei 4 Usern).
 */

async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('MIX')).toBeVisible({ timeout: 15_000 });
}

test('2 Browser-Kontexte synchronisieren die Session (2/4)', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await enterStudio(pageA);
  await enterStudio(pageB);

  await expect(pageA.getByText(/SESSION 2\/4/)).toBeVisible({ timeout: 20_000 });
  await expect(pageB.getByText(/SESSION 2\/4/)).toBeVisible({ timeout: 20_000 });

  await ctxA.close();
  await ctxB.close();
});

test('4 Browser-Kontexte → Session voll (VOLL/4)', async ({ browser }) => {
  const contexts = await Promise.all([1, 2, 3, 4].map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((c) => c.newPage()));

  for (const page of pages) {
    await enterStudio(page);
  }

  // 4 User = Session voll; der Header zeigt dann SESSION VOLL (oder 4/4).
  await expect(pages[0].getByText(/SESSION (VOLL|4\/4)/)).toBeVisible({ timeout: 30_000 });

  // DCT-102: AUTO_AI-Sync – User 1 schaltet den Sequencer ein, Peers sehen es.
  await pages[0].getByTitle('SEQ').click();
  await expect(pages[1].getByTitle('SEQ')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

  for (const ctx of contexts) {
    await ctx.close();
  }
});
