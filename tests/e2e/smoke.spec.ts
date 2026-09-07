import { test, expect, type Page } from '@playwright/test';

/**
 * E2E-Smoke: App lädt, Entry-Gate passieren, alle 18 Plugin-Buttons sind da,
 * Mixer-Terminal + MOA-Leiste rendern, Plugin-Toggle funktioniert und es gibt
 * keine uncaught pageerrors (White-Screen-Killer, DCT-104/118).
 *
 * Selektor-Stand 2026-09-07 (UI-Refactor): Die alte Plugin-Toolbar
 * (`nav[aria-label="Plugin-Toolbar"]` + `button[aria-pressed]` + Short-Codes
 * wie `title="MIX"`) wurde ersetzt durch die Studio-Navigation
 * (`nav[aria-label="Studio-Navigation"]`, `aria-current="page"` statt
 * `aria-pressed`, `title={plugin.name}` z. B. `mixerMONK` statt `MIX`).
 *
 * Bekannte, abgeschirmte Umgebungsfehler:
 *  - Tone.js legt Worklet-Polyfills als Blob an; Chromium meldet dafür
 *    gelegentlich „Unexpected token 'export'" (kein App-Fehler, kein Crash).
 */

const STUDIO_NAV = 'nav[aria-label="Studio-Navigation"]';

/** Short-Code → vollständiger Plugin-Name (title-Attribut im Header-Icon). */
const SHORT_TO_NAME: Record<string, string> = {
  INS: 'instrumentMONK',
  SYN: 'synthesizerMONK',
  DRM: 'drumMONK',
  SAM: 'samplerMONK',
  MCP: 'mcpMONK',
  VOX: 'voiceMONK',
  SND: 'soundMONK',
  MIX: 'mixerMONK',
  CTRL: 'midiMONK',
  FX: 'effectMONK',
  DRP: 'dropMONK',
  LIB: 'biblioMONK',
  EQ: 'eqMONK',
  DSP: 'dspMONK',
  MST: 'masteringMONK',
  RMX: 'stemMONK',
  '3D': 'spatialMONK',
  REC: 'recordingMONK',
};

/** Startseite öffnen und das „Studio betreten"-Gate passieren. */
async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator(STUDIO_NAV).getByTitle('mixerMONK').first())
    .toBeVisible({ timeout: 15_000 });
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
  await openStudio(page);

  const nav = page.locator(STUDIO_NAV);
  for (const short of Object.keys(SHORT_TO_NAME)) {
    await expect(nav.getByTitle(SHORT_TO_NAME[short]).first()).toBeVisible();
  }

  expect(errors.pageErrors).toEqual([]);
});

test('Mixer-Terminal rendert und MOA-Leiste ist sichtbar', async ({ page }) => {
  const errors = collectErrors(page);
  await openStudio(page);

  await page.locator(STUDIO_NAV).getByTitle('mixerMONK').first().click();
  await expect(page.getByText('mixerMONK · 6 CH')).toBeVisible();
  await expect(page.getByPlaceholder(/MOA/).first()).toBeVisible();

  expect(errors.pageErrors).toEqual([]);
});

test('Session-Anzeige zeigt 1/4', async ({ page }) => {
  const errors = collectErrors(page);
  await openStudio(page);
  await expect(page.getByText(/SESSION 1\/4/)).toBeVisible();
  expect(errors.pageErrors).toEqual([]);
});

test('Plugin-Toggle öffnet mcpMONK ohne React-Crash', async ({ page }) => {
  const errors = collectErrors(page);
  await openStudio(page);

  await page.locator(STUDIO_NAV).getByTitle('mcpMONK').first().click();
  await expect(page.getByText('mcpMONK').first()).toBeVisible({ timeout: 10_000 });

  expect(errors.pageErrors).toEqual([]);
});

test('P0-1: Studio-Start hat alle Nav-Buttons ohne aria-current (kein Modul aktiv)', async ({ page }) => {
  const errors = collectErrors(page);
  await openStudio(page);

  const nav = page.locator(STUDIO_NAV);
  const buttons = nav.locator('button');
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(18);
  // Neuer Nav-Semantik: aktives Modul = aria-current="page", Start = keins gesetzt.
  for (let i = 0; i < count; i++) {
    await expect(buttons.nth(i)).not.toHaveAttribute('aria-current', /.+/);
  }
  expect(errors.pageErrors).toEqual([]);
});

test('P0-3: Plugin-OFF im Terminal synchronisiert Nav-Icon (aria-current entfernt)', async ({ page }) => {
  const errors = collectErrors(page);
  await openStudio(page);

  const navButton = page.locator(STUDIO_NAV).getByTitle('mcpMONK').first();
  await navButton.click();
  const rack = page.locator('#rack-mcp');
  await expect(rack.getByText('mcpMONK').first()).toBeVisible({ timeout: 10_000 });
  await rack.locator('select').selectOption('OFF');
  await expect(navButton).not.toHaveAttribute('aria-current', /.+/);

  expect(errors.pageErrors).toEqual([]);
});

test('P0-7: masterplayerMONK ist fest oben sichtbar und View-only', async ({ page }) => {
  const errors = collectErrors(page);
  await openStudio(page);

  // masterplayerMONK ist der erste feste Rack-Block direkt unter dem Header.
  const master = page.locator('section').filter({ has: page.getByText('masterplayerMONK') }).first();
  await expect(master).toBeVisible();
  await expect(master.getByText('FIXED · VIEW ONLY')).toBeVisible();
  // Keine Eingaben: es gibt im masterplayer-Rack keine Buttons.
  await expect(master.locator('button')).toHaveCount(0);

  expect(errors.pageErrors).toEqual([]);
});
