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
/**
 * Short-Code → vollständiger Plugin-Name (title-Attribut im Header-Icon).
 * Exportiert, damit Specs NICHT ihre eigene (veraltete) Liste pflegen - genau das
 * war die Ursache der stale Namen in smoke.spec.ts (instrumentMONK, mcpMONK, ...).
 */
export const SHORT_TO_NAME: Record<string, string> = {
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

/**
 * Entry-Gate-Knopf („Studio betreten") lokalisieren.
 *
 * WARUM zentral (Befund Deep-Test T1, 2026-09-29): QUAL-P2-011 (2026-09-24) hat
 * das `aria-label="audioMONASTRY starten"` ABSICHTLICH entfernt
 * (Lighthouse `label-content-name-mismatch`: sichtbar „▶ Studio betreten" vs.
 * Label „audioMONASTRY starten"). Der zugängliche Name ist seitdem der sichtbare
 * Text. Die 17 Specs, die noch `getByLabel('audioMONASTRY starten')` nutzten,
 * liefen dadurch in den 30-s-Test-Timeout - 55 rote Tests mit EINER Ursache.
 * Nur stress.spec.ts hatte die robuste Rolle-Query und blieb grün.
 *
 * Der Alt-Name bleibt als Alternation erlaubt, damit ein (Wieder-)Einbau des
 * Labels die Suite nicht erneut bricht.
 */
export function entryButton(page: Page) {
  return page.getByRole('button', { name: /Studio betreten|audioMONASTRY starten/i });
}

/** Studio betreten und auf die Navigation warten. */
export async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await entryButton(page).click();
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

/**
 * UI2-P0-002: Modus-Button rechts am Plugin-Streifen (OFF → STBY → ON → OFF).
 * Ersetzt die alten „Power"/„Menü"-Knöpfe; das Header-Icon navigiert nur noch.
 */
export function modeButton(page: Page, name: string) {
  return page.getByRole('button', { name: new RegExp(`^${name} Modus `) });
}

/** Plugin-Streifen `#rack-<id>`; Zustand über `data-plugin-mode` / `data-plugin-owner`. */
export function rackRow(page: Page, id: string) {
  return page.locator(`#rack-${id}`);
}

/** Schaltet ein freies Plugin in zwei Schritten auf ON (holen → aktivieren). */
export async function switchPluginOn(page: Page, id: string, name: string): Promise<void> {
  await modeButton(page, name).click();
  await expect(rackRow(page, id)).toHaveAttribute('data-plugin-mode', 'STBY', { timeout: 15_000 });
  await modeButton(page, name).click();
  await expect(rackRow(page, id)).toHaveAttribute('data-plugin-mode', 'ON', { timeout: 15_000 });
}

/**
 * Menü im Kopf öffnen (Betreiber 2026-10-07): Einstellungen, Ausgänge,
 * Clipboard und Zwischenspeicher liegen hinter dem Menüknopf neben der
 * Nutzer-Anzeige.
 */
export async function openStudioMenu(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: 'Menü', exact: true });
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
}
