import { test, expect } from '@playwright/test';
import { STUDIO_NAV } from './helpers/studioNav';

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
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveScreenshot('02-studio.png', {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });
});

/** Nav-title (Plugin-Name) → Plugin-ID (Reihenfolge laut Registry, ohne ai; masterplayer ist Kopfzeile). */
const PLUGIN_ROWS: { title: string; id: string }[] = [
  { title: 'instrumentMONK', id: 'instrument' },
  { title: 'synthesizerMONK', id: 'synthesizer' },
  { title: 'drumMONK', id: 'drum' },
  { title: 'samplerMONK', id: 'sampler' },
  { title: 'mcpMONK', id: 'mcp' },
  { title: 'voiceMONK', id: 'voice' },
  { title: 'soundMONK', id: 'sound' },
  { title: 'songMONK', id: 'song' },
  { title: 'mixerMONK', id: 'mixer' },
  { title: 'midiMONK', id: 'controller' },
  { title: 'effectMONK', id: 'effect' },
  { title: 'dropMONK', id: 'drop' },
  { title: 'biblioMONK', id: 'library' },
  { title: 'eqMONK', id: 'eq' },
  { title: 'dspMONK', id: 'dsp' },
  { title: 'masteringMONK', id: 'mastering' },
  { title: 'stemMONK', id: 'stem' },
  { title: 'spatialMONK', id: 'spatial' },
  { title: 'recordingMONK', id: 'recording' },
  ];

test('P1-2: Screenshot-Baselines für alle 21 Plugin-/Sektions-Ansichten', async ({ page }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });

  // masterplayer (feste Sektion) + aiMONK (Bottom-Dock) sind immer sichtbar.
  await page.locator('#rack-masterplayer').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('03-plugin-masterplayer.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.06,
    mask: [page.locator('canvas')],
  });

  const toolbar = page.locator(STUDIO_NAV);
  for (const { title, id } of PLUGIN_ROWS) {
    const btn = toolbar.getByTitle(title).first();
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
