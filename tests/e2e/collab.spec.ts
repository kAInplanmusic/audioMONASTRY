import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Collaboration-Smoke (DCT-113 Basis): Mehrere Browser-Kontexte treten dem
 * Studio bei und die Session-Mitgliederzahl wird über Socket.io-Signaling
 * korrekt gespiegelt (SESSION n/4 bzw. SESSION VOLL bei 4 Usern).
 *
 * COLLAB-P0-002: Der Lauf ist fail-closed — ohne Studio-Token weist der Server
 * `/api` UND den Socket.io-Handshake mit 401 ab (live nachgestellt 2026-09-13).
 * Der Test setzt deshalb in JEDEM Kontext das `studio`-Cookie (Portal-Flow) und
 * gibt ein Fake-Mikrofon, damit `getUserMedia` headless nicht scheitert.
 */

/** Mikrofon-Fake für headless Chromium (wie in live2browser.spec.ts). */
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

/** Studio-Token: aus der Umgebung oder (lokal) aus der .env. */
function studioToken(): string {
  const fromEnv = (process.env.STUDIO_ACCESS_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const line = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('STUDIO_ACCESS_TOKEN='));
    return (line?.slice('STUDIO_ACCESS_TOKEN='.length) ?? '').trim().replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 15_000 });
}

/**
 * Erzeugt einen Browser-Kontext mit Studio-Cookie. Der Server liest den Token
 * aus dem `studio`-Cookie (vom Portal gesetzt) — für `http://localhost` ohne
 * `secure`, für https mit `secure: true`.
 */
async function newStudioContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const baseUrl = (process.env.BASE_URL ?? '').trim().replace(/\/$/, '') || 'http://localhost:8080';
  const token = studioToken();
  if (token) {
    const url = new URL(baseUrl);
    await ctx.addCookies([{
      name: 'studio',
      value: token,
      domain: url.hostname,
      path: '/',
      secure: url.protocol === 'https:',
      httpOnly: false,
    }]);
  }
  return ctx;
}

test('2 Browser-Kontexte synchronisieren die Session (2/4)', async ({ browser }) => {
  const ctxA = await newStudioContext(browser);
  const ctxB = await newStudioContext(browser);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await openStudio(pageA);
  await openStudio(pageB);

  await expect(pageA.getByText(/SESSION 2\/4/)).toBeVisible({ timeout: 20_000 });
  await expect(pageB.getByText(/SESSION 2\/4/)).toBeVisible({ timeout: 20_000 });

  await ctxA.close();
  await ctxB.close();
});

test('4 Browser-Kontexte → Session voll und auf allen Clients konsistent', async ({ browser }) => {
  const contexts = await Promise.all([1, 2, 3, 4].map(() => newStudioContext(browser)));
  const pages = await Promise.all(contexts.map((c) => c.newPage()));

  try {
    for (const page of pages) {
      await openStudio(page);
    }

    // COLLAB-P0-002: Nicht nur der erste Client — ALLE vier müssen denselben
    // Stand sehen ("SESSION VOLL" oder 4/4). Genau das war vorher kaputt: der
    // Server schickte die Mitgliederliste nur an den Beitretenden, die anderen
    // blieben auf "SESSION 1/4" stehen.
    for (const [index, page] of pages.entries()) {
      await expect(
        page.getByText(/SESSION (VOLL|4\/4)/),
        `Client ${index + 1} zeigt keinen vollen Session-Stand`,
      ).toBeVisible({ timeout: 30_000 });
    }

    // Regression zum gefundenen P0-Bug: kein Client darf sich als reiner
    // Listener (Ghostuser 5/6) anmelden. Das passierte, weil main.tsx beide
    // Listener-Seiten eager importiert und diese den Modus beim Import setzten.
    // (Der sessionMode()-Check ist unit-getestet; hier belegt der volle Zähler
    // auf allen vier Clients, dass alle als Session-User gezählt werden.)
  } finally {
    for (const ctx of contexts) {
      await ctx.close();
    }
  }
});
