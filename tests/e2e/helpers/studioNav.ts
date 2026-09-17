import { expect, type Page } from '@playwright/test';

/**
 * E2E-Hilfsmodul: Selektoren + Helfer für die Studio-Navigation
 * (Header-Icons, UI-Refactor 2026-09-06).
 *
 * Alt (entfernt): `nav[aria-label="Plugin-Toolbar"]` + `button[aria-pressed]`
 * + Short-Codes (`title="MIX"`).
 * Neu: `nav[aria-label="Studio-Navigation"]` + `aria-current="page"`
 * + vollständige Plugin-Namen (`title="mixerMONK"`).
 *
 * Achtung: Die Cue-/Monitor-Buttons im Rack nutzen weiterhin `aria-pressed`
 * (echte Toggle-Semantik) — das ist korrekt und wird NICHT umgestellt.
 */

export const STUDIO_NAV = 'nav[aria-label="Studio-Navigation"]';

/** Short-Code → vollständiger Plugin-Name (title-Attribut im Header-Icon, 16-MONK-Ziel). */
const SHORT_TO_NAME: Record<string, string> = {
  INS: 'instruMONK',
  SYSA: 'syntisamplerMONK',
  DRSA: 'drumsamplerMONK',
  VOX: 'voiceMONK',
  SND: 'soundMONK',
  MIX: 'mixerMONK',
  FX: 'effectMONK',
  DRP: 'dropMONK',
  LIB: 'biblioMONK',
  EQ: 'eqMONK',
  DSP: 'dspMONK',
  MST: 'masterMONK',
  RMX: 'stemMONK',
  '3D': 'spatialMONK',
  REC: 'recordMONK',
  SNG: 'songMONK',
};

/**
 * Anzahl der Plugin-Icons in der Studio-Navigation (16-MONK-Ziel).
 * Ableitung statt Zahl im Test: sonst bleibt beim naechsten Umbau wieder
 * eine veraltete Erwartung stehen (Befund 2026-09-17: Test wollte 19, real 16).
 */
export const STUDIO_NAV_COUNT = Object.keys(SHORT_TO_NAME).length;

/** Nav-Button für einen Short-Code (z. B. 'MIX') lokalisieren. */
export function navButton(page: Page, short: string) {
  return page.locator(STUDIO_NAV).getByTitle(SHORT_TO_NAME[short] ?? short).first();
}

/** Studio betreten und auf die Navigation warten. */
export async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(navButton(page, 'MIX')).toBeVisible({ timeout: 15_000 });
}

/** Bekannte Umgebungsfehler (Tone.js Worklet-Blob-Polyfills im Headless-Chromium). */
const IGNORED_PAGEERRORS = [
  "Unexpected token 'export'",
];

/** Sammelt uncaught pageerrors + console errors (gefiltert). */
export function collectErrors(page: Page): { pageErrors: string[]; consoleErrors: string[] } {
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
