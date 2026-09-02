import { test, expect, devices, type Page } from '@playwright/test';

/**
 * P1-1 Responsive-/Touch-Matrix
 * =============================
 * Prüft, dass Start- und Studio-Ansicht auf den Zielgeräten laden, ohne dass
 * das DOKUMENT horizontal overflowt (interne Scroll-Container wie der Mixer
 * sind erlaubt). Zusätzlich werden Touch-Zielgrößen der Plugin-Toolbar
 * geprüft (≥ 44px, P1-1).
 *
 * Browser-Matrix:
 *   - Chromium: iPhone SE/14, Pixel 7 (Android-Emulation), Desktop 1920
 *   - Firefox:  Desktop 1920
 *   - WebKit:   (Safari/iOS) in CI via `playwright install-deps`; lokal
 *               blockiert, siehe docs/HARDWARE_TEST_MATRIX_2026.md
 */

const TOOLBAR = 'nav[aria-label="Plugin-Toolbar"]';

/** Playwright-Geräteprofil ohne `defaultBrowserType` (Browser kommt aus dem Project). */
function mobileProfile(name: keyof typeof devices) {
  const { defaultBrowserType: _drop, ...profile } = devices[name];
  return profile;
}

async function startStudio(page: Page) {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator(TOOLBAR)).toBeVisible({ timeout: 30_000 });
}

/** Dokument-Overflow in CSS-Pixeln (scrollWidth - clientWidth). */
async function docOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await docOverflow(page);
  // 1px Toleranz für Rundungsdifferenzen (Subpixel).
  expect(overflow).toBeLessThanOrEqual(1);
}

/** Minimale Touch-Zielhöhe aller Plugin-Toolbar-Buttons. */
async function toolbarMinHeight(page: Page): Promise<number> {
  return page
    .locator(`${TOOLBAR} button`)
    .evaluateAll((btns) => Math.min(...btns.map((b) => b.getBoundingClientRect().height)));
}

async function toggleMixerOnTouch(page: Page) {
  // Präziser Toolbar-Selektor: getByTitle('MIX') würde auch die Monitor-Quelle
  // (title="Monitor-Quelle: MAIN / eigener User-Mix …") treffen.
  const mix = page.locator(`${TOOLBAR} button[aria-label^="MIX "]`);
  await mix.tap();
  await expect(mix).toHaveAttribute('aria-pressed', 'true');
}

test.describe('Responsive/Touch-Matrix', () => {
  test.describe('iPhone SE (320×568)', () => {
    test.use(mobileProfile('iPhone SE'));
    test.skip(({ browserName }) => browserName === 'firefox', 'iOS/Android-Matrix nur Chromium (WebKit in CI)');

    test('Studio lädt ohne horizontalen Overflow, Touch-Ziele ≥ 44px', async ({ page }) => {
      await startStudio(page);
      await expectNoHorizontalOverflow(page);
      expect(await toolbarMinHeight(page)).toBeGreaterThanOrEqual(44);
    });

    test.describe('Querformat (568×320)', () => {
      test.use({ viewport: { width: 568, height: 320 } });

      test('Studio lädt ohne horizontalen Overflow', async ({ page }) => {
        await startStudio(page);
        await expectNoHorizontalOverflow(page);
      });
    });
  });

  test.describe('iPhone 14 (390×844)', () => {
    test.use(mobileProfile('iPhone 14'));
    test.skip(({ browserName }) => browserName === 'firefox', 'iOS/Android-Matrix nur Chromium (WebKit in CI)');

    test('Studio lädt ohne horizontalen Overflow', async ({ page }) => {
      await startStudio(page);
      await expectNoHorizontalOverflow(page);
    });

    test.describe('Querformat (844×390)', () => {
      test.use({ viewport: { width: 844, height: 390 } });

      test('Studio lädt ohne Overflow und Plugin-Toggle funktioniert', async ({ page }) => {
        await startStudio(page);
        await expectNoHorizontalOverflow(page);
        await toggleMixerOnTouch(page);
      });
    });
  });

  test.describe('Pixel 7 (412×915)', () => {
    test.use(mobileProfile('Pixel 7'));
    test.skip(({ browserName }) => browserName === 'firefox', 'iOS/Android-Matrix nur Chromium (WebKit in CI)');

    test('Studio lädt ohne horizontalen Overflow', async ({ page }) => {
      await startStudio(page);
      await expectNoHorizontalOverflow(page);
    });

    test.describe('Querformat (915×412)', () => {
      test.use({ viewport: { width: 915, height: 412 } });

      test('Studio lädt ohne Overflow und Plugin-Toggle funktioniert', async ({ page }) => {
        await startStudio(page);
        await expectNoHorizontalOverflow(page);
        await toggleMixerOnTouch(page);
      });
    });
  });

  test.describe('iPad (Gen 7) Querformat (1080×810)', () => {
    test.use({ viewport: { width: 1080, height: 810 }, hasTouch: true, isMobile: true });
    test.skip(({ browserName }) => browserName === 'firefox', 'iOS/Android-Matrix nur Chromium (WebKit in CI)');

    test('Studio lädt ohne horizontalen Overflow', async ({ page }) => {
      await startStudio(page);
      await expectNoHorizontalOverflow(page);
    });
  });

  test.describe('iPad 16:9 Breitbild (1180×664)', () => {
    test.use({ viewport: { width: 1180, height: 664 }, hasTouch: true, isMobile: true });
    test.skip(({ browserName }) => browserName === 'firefox', 'iOS/Android-Matrix nur Chromium (WebKit in CI)');

    test('Studio lädt ohne Overflow, Header-Auswahl-Icons sichtbar', async ({ page }) => {
      await startStudio(page);
      await expectNoHorizontalOverflow(page);
      await expect(page.locator('nav[aria-label="Studio-Navigation"]')).toBeVisible();
      await expect(page.locator('nav[aria-label="Studio-Navigation"] button')).toHaveCount(10);
    });
  });

  test.describe('iPad Pro 16:9 Breitbild (1366×768)', () => {
    test.use({ viewport: { width: 1366, height: 768 }, hasTouch: true, isMobile: true });
    test.skip(({ browserName }) => browserName === 'firefox', 'iOS/Android-Matrix nur Chromium (WebKit in CI)');

    test('Studio lädt ohne Overflow', async ({ page }) => {
      await startStudio(page);
      await expectNoHorizontalOverflow(page);
    });
  });

  test.describe('Desktop 1920×1080', () => {
    test.use({ viewport: { width: 1920, height: 1080 } });

    test('Studio lädt ohne Overflow und alle Plugin-Icons sind sichtbar', async ({ page }) => {
      await startStudio(page);
      await expectNoHorizontalOverflow(page);
      // Masterplayer + aiMONK (im Dock) werden ausgeblendet; die übrigen
      // 19 Plugin-Kacheln müssen in der Toolbar liegen.
      await expect(page.locator(`${TOOLBAR} button`)).toHaveCount(19);
    });
  });
});
