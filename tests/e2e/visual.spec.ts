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
  await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveScreenshot('02-studio.png', {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });
});

/** Toolbar-Kürzel → Plugin-ID (Reihenfolge laut Registry, ohne masterplayer/ai). */
const PLUGIN_ROWS: { short: string; id: string }[] = [
  { short: 'INS', id: 'instrument' },
  { short: 'SYN', id: 'synthesizer' },
  { short: 'DRM', id: 'drum' },
  { short: 'SAM', id: 'sampler' },
  { short: 'MCP', id: 'mcp' },
  { short: 'VOX', id: 'voice' },
  { short: 'SND', id: 'sound' },
  { short: 'MIX', id: 'mixer' },
  { short: 'CTRL', id: 'controller' },
  { short: 'FX', id: 'effect' },
  { short: 'DRP', id: 'drop' },
  { short: 'LIB', id: 'library' },
  { short: 'EQ', id: 'eq' },
  { short: 'DSP', id: 'dsp' },
  { short: 'MST', id: 'mastering' },
  { short: 'RMX', id: 'stem' },
  { short: '3D', id: 'spatial' },
  { short: 'REC', id: 'recording' },
  { short: 'PRF', id: 'performance' },
];

test('P1-2: Screenshot-Baselines für alle 20 Plugin-/Sektions-Ansichten', async ({ page }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 20_000 });

  // masterplayer (feste Sektion) + aiMONK (Bottom-Dock) sind immer sichtbar.
  await page.locator('#rack-masterplayer').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('03-plugin-masterplayer.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.06,
    mask: [page.locator('canvas')],
  });

  const toolbar = page.locator('nav[aria-label="Plugin-Toolbar"]');
  for (const { short, id } of PLUGIN_ROWS) {
    const btn = toolbar.getByTitle(short).first();
    await btn.click();
    const rack = page.locator(`#rack-${id}`);
    await expect(rack).toBeVisible({ timeout: 20_000 });
    // Instrument-Terminal lädt seine Liste asynchron – erst abwarten, sonst
    // verschiebt sich der Rack-Inhalt zwischen den Screenshots.
    if (id === 'instrument') {
      await expect(page.getByText(/100 \/ 100 Instrumente/)).toBeVisible({ timeout: 20_000 });
    }
    // Bilder im Terminal fertig laden, sonst reflowt das Rack zwischen den
    // beiden Stabilitäts-Screenshots (instabile Baseline).
    await rack.evaluate((el) => Promise.all(
      Array.from(el.querySelectorAll('img')).map((img) =>
        (img as HTMLImageElement).complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              (img as HTMLImageElement).onload = () => resolve();
              (img as HTMLImageElement).onerror = () => resolve();
            }),
      ),
    ));
    await page.waitForTimeout(1200); // Terminal/Rack-Render abwarten
    await page.mouse.move(0, 0); // Hover-Highlights aus dem Weg räumen
    await page.waitForTimeout(200);
    await rack.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot(`03-plugin-${id}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.06,
      mask: [page.locator('canvas')],
    });
    await btn.click(); // wieder schließen (OFF)
  }

  await page.mouse.move(0, 0);
  await page.locator('#ai-monk-dock').evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  await expect(page).toHaveScreenshot('03-plugin-ai.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.06,
    mask: [page.locator('canvas'), page.locator('#ai-monk-dock div.max-h-28')],
  });
});
