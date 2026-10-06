import { test, expect, type Page } from '@playwright/test';
import { entryButton, rackRow } from './helpers/studioNav';
import { resetSession } from './helpers/studioAuth';

/**
 * Formate (Betreiber 2026-10-06): Handy quer (Vollbild) · Handy hochkant
 * (vereinfachte Ansicht) · Pad quer (Vollbild) · PC/Laptop quer.
 * Erkennung automatisch aus Gerät, Ausrichtung und Auflösung
 * (src/core/ui/deviceLayout.ts → data-layout an <html>).
 *
 * Nur Chromium: Touch-/Mobil-Emulation (isMobile) gibt es in Firefox nicht,
 * und WebKit meldet `pointer: coarse` in der Emulation nicht verlässlich.
 */
test.skip(({ browserName }) => browserName !== 'chromium', 'nur Chromium: Mobil-Emulation');

test.beforeEach(async () => {
  await resetSession();
});

async function enter(page: Page): Promise<void> {
  await page.goto('/');
  await entryButton(page).click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });
}

async function layoutOf(page: Page) {
  return page.evaluate(() => ({
    layout: document.documentElement.dataset.layout ?? '',
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    fullscreen: !!document.fullscreenElement,
  }));
}

test.describe('Handy hochkant – vereinfachte Ansicht', () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('erkennt das Format, ohne waagerechten Überlauf, Bedienflächen nur auf Wunsch', async ({ page }) => {
    await enter(page);
    const l = await layoutOf(page);
    expect(l.layout).toBe('phone-portrait');
    expect(l.scrollWidth, 'Seite darf nicht breiter als der Bildschirm sein').toBeLessThanOrEqual(l.innerWidth);
    expect(l.fullscreen).toBe(false);

    await expect(page.getByTestId('simplified-hint')).toBeVisible();
    // Signalweg-Leiste und Visualizer fallen weg.
    await expect(page.getByRole('navigation', { name: 'Signalweg' })).toBeHidden();

    // Der einzige Nutzer hält den Mixer: Pult eingeklappt, PLAY in der Kopfzeile.
    const mixer = rackRow(page, 'mixer');
    await expect(mixer).toHaveAttribute('data-plugin-owner', 'me', { timeout: 15_000 });
    await expect(page.getByTestId('panel-hint-mixer')).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Main-Out LEVEL' })).toHaveCount(0);
    await expect(mixer.getByRole('button', { name: 'Main starten' })).toBeVisible();

    // „Hier öffnen" zeigt das Pult – es scrollt in sich, nicht die Seite.
    await mixer.getByRole('button', { name: 'mixerMONK Bedienfläche hier öffnen' }).click();
    await expect(page.getByRole('slider', { name: 'Main-Out LEVEL' })).toBeVisible();
    const after = await layoutOf(page);
    expect(after.scrollWidth).toBeLessThanOrEqual(after.innerWidth);
  });
});

test.describe('Handy quer – Vollbild', () => {
  test.use({ viewport: { width: 852, height: 393 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('erkennt das Format, geht beim Betreten ins Vollbild, aiMONK eingeklappt', async ({ page }) => {
    await enter(page);
    const l = await layoutOf(page);
    expect(l.layout).toBe('phone-landscape');
    expect(l.scrollWidth).toBeLessThanOrEqual(l.innerWidth);
    expect(l.fullscreen, 'Vollbild nach dem Tippen auf „Studio betreten"').toBe(true);
    await expect(page.getByRole('button', { name: 'aiMONK öffnen' })).toBeVisible();
    // Volle Oberfläche: das Pult ist beim Halter offen.
    await expect(page.getByRole('slider', { name: 'Main-Out LEVEL' })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Pad quer – Vollbild', () => {
  test.use({ viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('erkennt das Format und geht beim Betreten ins Vollbild', async ({ page }) => {
    await enter(page);
    const l = await layoutOf(page);
    expect(l.layout).toBe('tablet-landscape');
    expect(l.scrollWidth).toBeLessThanOrEqual(l.innerWidth);
    expect(l.fullscreen).toBe(true);
    await expect(page.getByRole('navigation', { name: 'Signalweg' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vollbild beenden' })).toBeVisible();
  });
});

test.describe('PC/Laptop quer', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test('erkennt das Format, bleibt im Browserfenster und zeigt Format + Auflösung', async ({ page }) => {
    await enter(page);
    const l = await layoutOf(page);
    expect(l.layout).toBe('desktop');
    expect(l.scrollWidth).toBeLessThanOrEqual(l.innerWidth);
    expect(l.fullscreen).toBe(false);
    await expect(page.getByTestId('layout-label')).toHaveText(/PC\/Laptop · 1600×900 @1x/);
    await expect(page.getByTestId('simplified-hint')).toHaveCount(0);
    // Am PC kein eigener Vollbild-Knopf (Browser-Vollbild/F11 bleibt).
    await expect(page.getByRole('button', { name: 'Vollbild' })).toHaveCount(0);
  });
});

test.describe('Drehen', () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('Handy hochkant → quer wechselt live in die volle Oberfläche', async ({ page }) => {
    await enter(page);
    expect((await layoutOf(page)).layout).toBe('phone-portrait');
    await page.setViewportSize({ width: 852, height: 393 });
    await expect.poll(async () => (await layoutOf(page)).layout).toBe('phone-landscape');
    await expect(page.getByTestId('simplified-hint')).toHaveCount(0);
    await expect(page.getByRole('slider', { name: 'Main-Out LEVEL' })).toBeVisible({ timeout: 15_000 });
  });
});
