import { test, expect, type Page } from '@playwright/test';

/**
 * E2E-Smoke: App lädt, Entry-Gate passieren, alle 20 Plugin-Buttons sind da,
 * Mixer-Terminal + MOA-Leiste rendern, Plugin-Toggle funktioniert und es gibt
 * keine uncaught pageerrors (White-Screen-Killer, DCT-104/118).
 */

const PLUGIN_SHORTS = [
  'INS', 'SYN', 'DRM', 'SAM', 'SEQ', 'VOX', 'SND',
  'MIX', 'CTRL', 'FX', 'DRP', 'LIB', 'EQ', 'DSP',
  'MST', 'RMX', '3D', 'REC', 'PRF', 'AI',
];

/** Startseite öffnen und das „Studio betreten"-Gate passieren. */
async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('MIX').first()).toBeVisible({ timeout: 15_000 });
}

/** Sammelt uncaught pageerrors (console.error wird nur protokolliert, da im Headless-Browser AudioContext-Warnungen erwartbar sind). */
function collectErrors(page: Page): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  return { pageErrors, consoleErrors };
}

test('App lädt mit korrektem Titel und 20 Plugin-Buttons', async ({ page }) => {
  const errors = collectErrors(page);
  await enterStudio(page);

  for (const short of PLUGIN_SHORTS) {
    await expect(page.getByTitle(short).first()).toBeVisible();
  }

  expect(errors.pageErrors).toEqual([]);
});

test('Mixer-Terminal rendert und MOA-Leiste ist sichtbar', async ({ page }) => {
  const errors = collectErrors(page);
  await enterStudio(page);

  await expect(page.getByText('PRO-MIX 9000')).toBeVisible();
  await expect(page.getByPlaceholder(/MOA/).first()).toBeVisible();

  expect(errors.pageErrors).toEqual([]);
});

test('Session-Anzeige zeigt 1/4', async ({ page }) => {
  const errors = collectErrors(page);
  await enterStudio(page);
  await expect(page.getByText(/SESSION 1\/4/)).toBeVisible();
  expect(errors.pageErrors).toEqual([]);
});

test('Plugin-Toggle öffnet den Sequencer ohne React-Crash', async ({ page }) => {
  const errors = collectErrors(page);
  await enterStudio(page);

  await page.getByTitle('SEQ').click();
  await expect(page.getByText('SEQUENCER MONK')).toBeVisible({ timeout: 10_000 });

  expect(errors.pageErrors).toEqual([]);
});
