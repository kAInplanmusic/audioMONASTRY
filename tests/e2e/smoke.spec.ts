import { test, expect, type Page } from '@playwright/test';

/**
 * E2E-Smoke: App lädt, Entry-Gate passieren, alle 18 Plugin-Buttons sind da,
 * Mixer-Terminal + MOA-Leiste rendern, Plugin-Toggle funktioniert und es gibt
 * keine uncaught pageerrors (White-Screen-Killer, DCT-104/118).
 *
 * Bekannte, abgeschirmte Umgebungsfehler:
 *  - Tone.js legt Worklet-Polyfills als Blob an; Chromium meldet dafür
 *    gelegentlich „Unexpected token 'export'" (kein App-Fehler, kein Crash).
 */

const PLUGIN_SHORTS = [
  'INS', 'SYN', 'DRM', 'SAM', 'MCP', 'VOX', 'SND',
  'MIX', 'CTRL', 'FX', 'DRP', 'LIB', 'EQ', 'DSP',
  'MST', 'RMX', '3D', 'REC',
];

/** Startseite öffnen und das „Studio betreten"-Gate passieren. */
async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  const toolbar = page.locator('nav[aria-label="Plugin-Toolbar"]');
  await expect(toolbar.getByTitle('MIX').first()).toBeVisible({ timeout: 15_000 });
}

const IGNORED_PAGEERRORS = [
  "Unexpected token 'export'", // Tone.js Worklet-Blob-Polyfill (Chromium)
];

/** Sammelt uncaught pageerrors, filtert bekannte Umgebungsfehler. */
function collectErrors(page: Page): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => {
    if (!IGNORED_PAGEERRORS.some((needle) => e.message.includes(needle))) {
      pageErrors.push(e.message);
    }
  });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  return { pageErrors, consoleErrors };
}

test('App lädt mit korrektem Titel und 18 Plugin-Buttons', async ({ page }) => {
  const errors = collectErrors(page);
  await enterStudio(page);

  const toolbar = page.locator('nav[aria-label="Plugin-Toolbar"]');
  for (const short of PLUGIN_SHORTS) {
    await expect(toolbar.getByTitle(short).first()).toBeVisible();
  }

  expect(errors.pageErrors).toEqual([]);
});

test('Mixer-Terminal rendert und MOA-Leiste ist sichtbar', async ({ page }) => {
  const errors = collectErrors(page);
  await enterStudio(page);

  await page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('MIX').first().click();
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

test('Plugin-Toggle öffnet mcpMONK ohne React-Crash', async ({ page }) => {
  const errors = collectErrors(page);
  await enterStudio(page);

  await page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('MCP').first().click();
  await expect(page.getByText('mcpMONK').first()).toBeVisible({ timeout: 10_000 });

  expect(errors.pageErrors).toEqual([]);
});

test('P0-1: Studio-Start hat 0 aktive Plugins (alle Toolbar-Icons gedimmt)', async ({ page }) => {
  const errors = collectErrors(page);
  await enterStudio(page);

  const toolbar = page.locator('nav[aria-label="Plugin-Toolbar"]');
  const buttons = toolbar.locator('button[aria-pressed]');
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(18);
  for (let i = 0; i < count; i++) {
    await expect(buttons.nth(i)).toHaveAttribute('aria-pressed', 'false');
  }
  expect(errors.pageErrors).toEqual([]);
});

test('P0-3: Plugin-OFF im Terminal synchronisiert Toolbar-Icon', async ({ page }) => {
  const errors = collectErrors(page);
  await enterStudio(page);

  await page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('MCP').first().click();
  const rack = page.locator('#rack-mcp');
  await expect(rack.getByText('mcpMONK').first()).toBeVisible({ timeout: 10_000 });
  await rack.locator('select').selectOption('OFF');
  await expect(page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('MCP').first()).toHaveAttribute('aria-pressed', 'false');

  expect(errors.pageErrors).toEqual([]);
});

test('P0-7: masterplayerMONK ist fest oben sichtbar und View-only', async ({ page }) => {
  const errors = collectErrors(page);
  await enterStudio(page);

  // masterplayerMONK ist der erste feste Rack-Block direkt unter dem Header.
  const master = page.locator('section').filter({ has: page.getByText('masterplayerMONK') }).first();
  await expect(master).toBeVisible();
  await expect(master.getByText('FIXED · VIEW ONLY')).toBeVisible();
  // Keine Eingaben: es gibt im masterplayer-Rack keine Buttons.
  await expect(master.locator('button')).toHaveCount(0);

  expect(errors.pageErrors).toEqual([]);
});
