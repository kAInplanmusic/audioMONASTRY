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
 * E2E-Isolation: setzt den serverautoritativen Session-State zurück. Die
 * In-Memory-Session lebt länger als ein einzelner Browser-Kontext; ohne Reset
 * würden Modul-States/Locks aus einem vorherigen Test in den nächsten bluten.
 * Der Hook ist dev-only (Production: 404) und verlangt den Studio-Token.
 */
async function resetSession(): Promise<void> {
  const baseUrl = (process.env.E2E_BASE_URL ?? '').trim().replace(/\/$/, '') || 'http://localhost:8080';
  const token = studioToken();
  const res = await fetch(`${baseUrl}/api/session/reset`, {
    method: 'POST',
    headers: token ? { 'x-studio-token': token } : {},
  });
  if (!res.ok) throw new Error(`session reset fehlgeschlagen: ${res.status} ${await res.text()}`);
}

test.beforeEach(async () => {
  await resetSession();
});

/**
 * Erzeugt einen Browser-Kontext mit Studio-Cookie. Der Server liest den Token
 * aus dem `studio`-Cookie (vom Portal gesetzt) — für `http://localhost` ohne
 * `secure`, für https mit `secure: true`.
 */
async function newStudioContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const baseUrl = (process.env.E2E_BASE_URL ?? '').trim().replace(/\/$/, '') || 'http://localhost:8080';
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

test('COLLAB-P1-004: aktive Plugin-Navigation wird an den anderen Client gespiegelt', async ({ browser }) => {
  const ctxA = await newStudioContext(browser);
  const ctxB = await newStudioContext(browser);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    await openStudio(pageA);
    await openStudio(pageB);

    // Client A navigiert auf eqMONK. Client B darf keinen eigenen Klick
    // ausführen – er muss die Navigation über den Server-Relay sehen.
    await pageA.getByTitle('eqMONK').first().click();

    // Der Header-Badge auf Client B zeigt die Remote-Navigation als
    // "<userId>→eq" (fuchsia, nur ab xl-Viewport sichtbar).
    await expect(
      pageB.getByText(/u[a-z0-9]+→eq$/),
      'Client B zeigt die gespiegelte eqMONK-Navigation nicht an',
    ).toBeVisible({ timeout: 15_000 });

    // Sanity: Client A selbst bekommt die eigene Navigation nicht als
    // Remote-Badge (der Server relayt nur an die anderen Sockets).
    await expect(pageA.getByText(/u[a-z0-9]+→eq$/)).toHaveCount(0);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test('COLLAB-P0-002: Nachzügler sieht Modul-Stand aus dem Server-Snapshot (kein Pumping)', async ({ browser }) => {
  const ctxA = await newStudioContext(browser);
  const pageA = await ctxA.newPage();

  try {
    // Erst A: aktiviert eqMONK (AUTO_AI), BEVOR ein zweiter Client existiert.
    await openStudio(pageA);
    await pageA.getByTitle('eqMONK').first().click();
    await expect(pageA.locator('#rack-eq').getByText('AUTO_AI').first()).toBeVisible();

    // Jetzt stößt B dazu. Der Server hat für eq bereits AUTO_AI im
    // autoritativen Snapshot; B bekommt kein replays der alten Events.
    const ctxB = await newStudioContext(browser);
    const pageB = await ctxB.newPage();
    try {
      await openStudio(pageB);
      await expect(
        pageB.locator('#rack-eq').getByText('AUTO_AI').first(),
        'Client B muss den eqMONK-Stand aus dem session-state Snapshot wiederherstellen',
      ).toBeVisible({ timeout: 20_000 });
    } finally {
      await ctxB.close();
    }
  } finally {
    await ctxA.close();
  }
});

test('COLLAB-P0-002: Lock-Denial + Resync stellt Server-Wahrheit wieder her', async ({ browser }) => {
  const ctxA = await newStudioContext(browser);
  const ctxB = await newStudioContext(browser);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    await openStudio(pageA);
    await openStudio(pageB);

    // A übernimmt eqMONK per Rack-Menü (AUTO_AI → Lock → PRO).
    await pageA.getByLabel('eqMONK Menü').click();
    await expect(pageA.locator('#rack-eq').getByText('PRO').first()).toBeVisible();

    // B sieht den Fremd-Lock an der eq-Zeile.
    await expect(pageB.locator('#rack-eq').getByText('LOCKED · REMOTE')).toBeVisible({ timeout: 15_000 });

    // B versucht, eq per Power zu schalten. Der Server lehnt ab (Lock bei A);
    // Bs lokaler Zustand ist danach optimistisch OFF.
    await pageB.getByLabel('eqMONK Power').click();
    await expect(pageB.locator('#rack-eq').getByText('OFF').first()).toBeVisible();

    // A behält den Lock und den PRO-Zustand (Server-Wahrheit unverändert).
    await expect(pageA.locator('#rack-eq').getByText('PRO').first()).toBeVisible();
    await expect(pageA.locator('#rack-eq').getByText('LOCKED · REMOTE')).toHaveCount(0);

    // Resync: B fordert den autoritativen Snapshot an und übernimmt ihn
    // (Reconnect ohne Pumping) – eq ist wieder PRO und von A gelockt.
    await pageB.evaluate(() => (window as any).__webRTCManager?.requestSessionResync());
    await expect(pageB.locator('#rack-eq').getByText('PRO').first()).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator('#rack-eq').getByText('LOCKED · REMOTE')).toBeVisible();
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
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
