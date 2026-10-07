import { test, expect, type BrowserContextOptions } from '@playwright/test';
import { entryButton } from './helpers/studioNav';
import { newStudioContext, resetSession } from './helpers/studioAuth';

/**
 * Formate (Betreiber 2026-10-06): „Jedes Gerät gleiche Kopie, nur in klein."
 * Handy und Pad zeichnen die Referenzbreite (1440 px) und der Browser
 * verkleinert sie; der PC zeigt dieselbe Oberfläche in seiner Fensterbreite.
 * Handy quer und Pad quer wollen Vollbild. Ignoriert der Browser im Vollbild
 * die Viewport-Angabe (Chromium tut das, gemessen), verlässt die App das
 * Vollbild sofort wieder – die gleiche Kopie geht vor – und zeigt den Hinweis
 * auf die Home-Bildschirm-App (Manifest display: fullscreen).
 *
 * Nur Chromium: Mobil-Emulation (isMobile, Viewport-Angabe) gibt es in
 * Firefox nicht, und WebKit meldet `pointer: coarse` nicht verlässlich.
 */
test.skip(({ browserName }) => browserName !== 'chromium', 'nur Chromium: Mobil-Emulation');

test.beforeEach(async () => {
  await resetSession();
});

const FORMATS: { name: string; layout: string; wantsFullscreen: boolean; options: BrowserContextOptions }[] = [
  { name: 'Handy hochkant', layout: 'phone-portrait', wantsFullscreen: false, options: { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  { name: 'Handy quer', layout: 'phone-landscape', wantsFullscreen: true, options: { viewport: { width: 852, height: 393 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  { name: 'Pad quer', layout: 'tablet-landscape', wantsFullscreen: true, options: { viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  { name: 'PC/Laptop', layout: 'desktop', wantsFullscreen: false, options: { viewport: { width: 1440, height: 900 } } },
];

test('jedes Gerät zeigt dieselbe Kopie in 1440 px – Handy und Pad nur verkleinert', async ({ browser }) => {
  test.setTimeout(120_000);
  const results: Record<string, { innerWidth: number; mixerWidth: number; navRows: string; scrollWidth: number }> = {};
  for (const f of FORMATS) {
    const ctx = await newStudioContext(browser, f.options);
    try {
      const page = await ctx.newPage();
      await page.goto('/');
      await entryButton(page).click();
      await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.layout), { message: f.name }).toBe(f.layout);
      await expect.poll(() => page.evaluate(() => Math.abs(window.innerWidth - 1440) <= 2), { message: `${f.name}: Referenzbreite` }).toBe(true);
      if (f.wantsFullscreen) {
        // Chromium ignoriert im Vollbild die Viewport-Angabe → zurück, Hinweis auf die Home-Bildschirm-App.
        await expect.poll(() => page.evaluate(() => !!document.fullscreenElement), { message: `${f.name}: Vollbild verlassen` }).toBe(false);
        await expect(page.getByTestId('install-hint')).toBeVisible();
      } else {
        await expect(page.getByTestId('install-hint')).toHaveCount(0);
      }
      // Volle Oberfläche überall: das Pult ist beim Halter offen, keine Sonderansicht.
      await expect(page.getByRole('slider', { name: 'Main-Out LEVEL' })).toBeVisible({ timeout: 15_000 });
      results[f.name] = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        mixerWidth: Math.round(document.getElementById('rack-mixer')?.getBoundingClientRect().width ?? 0),
        navRows: getComputedStyle(document.querySelector('nav[aria-label="Studio-Navigation"]') as Element).gridTemplateColumns,
        scrollWidth: document.documentElement.scrollWidth,
      }));
    } finally {
      await ctx.close();
    }
  }
  const pc = results['PC/Laptop'];
  for (const f of FORMATS) {
    const r = results[f.name];
    expect(r.scrollWidth, `${f.name}: kein waagerechter Überlauf`).toBeLessThanOrEqual(r.innerWidth);
    expect(Math.abs(r.mixerWidth - pc.mixerWidth), `${f.name}: Mixer gleich breit wie am PC`).toBeLessThanOrEqual(2);
    expect(r.navRows, `${f.name}: Kopf gleich aufgebaut wie am PC`).toBe(pc.navRows);
  }
});

test.describe('Drehen', () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('Handy hochkant → quer: Format wechselt live, die Kopie bleibt dieselbe', async ({ page }) => {
    await page.goto('/');
    await entryButton(page).click();
    await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.layout)).toBe('phone-portrait');
    await page.setViewportSize({ width: 852, height: 393 });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.layout)).toBe('phone-landscape');
    await expect.poll(() => page.evaluate(() => Math.abs(window.innerWidth - 1440) <= 2)).toBe(true);
    await expect(page.getByRole('slider', { name: 'Main-Out LEVEL' })).toBeVisible();
  });
});
