import { test, expect, type Page } from '@playwright/test';
import { newStudioContext, resetSession, studioBaseUrl, studioToken } from './helpers/studioAuth';

// Nur Chromium: Die Suite nutzt Chromium-Fake-Media-Args fuer getUserMedia und mehrere eigene Browser-Kontexte; in WebKit bricht der Start ab ('browserType.launch: Target page, context or browser has been closed').
// CI-Fund 2026-09-17 (e2e-webkit): 'browserType.launch: Target page, context or browser has been closed'.
test.skip(({ browserName }) => browserName !== 'chromium', 'nur Chromium: Fake-Media-Args + Mehrkontext-Session');

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

// Studio-Token/-Kontext und Session-Reset liegen zentral in
// tests/e2e/helpers/studioAuth.ts - live2browser.spec.ts scheiterte daran, dass es
// diese Regel NICHT nutzte (401 fuer den zweiten Kontext).
async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async () => {
  await resetSession();
});

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

    // B sieht den Fremd-Lock an der eq-Zeile ...
    await expect(pageB.locator('#rack-eq').getByText('LOCKED · REMOTE')).toBeVisible({ timeout: 15_000 });

    // ... und muss As PRO-Stand übernommen haben, BEVOR der Power-Klick kommt.
    // "LOCKED · REMOTE" beweist nur den Lock: Bs eigener Modul-State ist davon
    // unabhängig und startet bei OFF. Klickt der Test zu früh, schaltet Power
    // nicht PRO->OFF, sondern OFF->AUTO_AI - ein sichtbares "OFF" gibt es danach
    // nie mehr, nur noch den versteckten <option>-Eintrag. Genau das war die
    // Flakiness (2 von 4 Läufen rot, identisch auch auf dem Baseline-Commit).
    await expect(pageB.locator('#rack-eq').getByText('PRO').first()).toBeVisible({ timeout: 15_000 });

    // B versucht, eq per Power zu schalten. Der Server lehnt ab (Lock bei A);
    // Bs lokaler Zustand ist danach optimistisch OFF.
    await pageB.getByLabel('eqMONK Power').click();
    // Und hier NICHT einfach getByText('OFF').first() nehmen: das Terminal-
    // <select> der Zeile enthält zusätzlich <option value="OFF">OFF</option>,
    // und die Option steht in der DOM-Reihenfolge vor dem Status-Span - .first()
    // landet dort und toBeVisible() kann nie grün werden (Playwright-Log:
    // "18 × resolved to <option value=OFF>, received hidden"). filter({ visible:
    // true }) meint den Status-Span, den der Nutzer sieht.
    await expect(
      pageB.locator('#rack-eq').getByText('OFF').filter({ visible: true }).first(),
    ).toBeVisible();

    // A behält den Lock und den PRO-Zustand (Server-Wahrheit unverändert).
    await expect(pageA.locator('#rack-eq').getByText('PRO').first()).toBeVisible();
    await expect(pageA.locator('#rack-eq').getByText('LOCKED · REMOTE')).toHaveCount(0);

    // Resync: B verbindet sich neu und übernimmt den autoritativen Server-Stand
    // (Reconnect ohne Pumping) – eq ist wieder PRO und von A gelockt.
    //
    // WARUM NEU LADEN UND NICHT `requestSessionResync()`: der Debug-Hook
    // `window.__webRTCManager` wird ABSICHTLICH nur im Dev-Build gesetzt
    // (`if (import.meta.env?.DEV)` in src/utils/WebRTCManager.ts). Ein Test, der
    // ihn benutzt, kann gegen einen Produktions-Build oder eine echte Instanz
    // grundsaetzlich nicht gruen werden - live und im lokalen Prod-Build sind
    // genau diese zwei Tests daran gescheitert (5/7). Der Reconnect ist der Pfad,
    // den ein Nutzer auch hat.
    await pageB.reload();
    await openStudio(pageB);
    await pageB.locator('#rack-eq').evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
    await expect(pageB.locator('#rack-eq').getByText('PRO').first()).toBeVisible({ timeout: 20_000 });
    await expect(pageB.locator('#rack-eq').getByText('LOCKED · REMOTE')).toBeVisible();
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test('COLLAB-P0-004 Teil 2: Halter-Uebergabe des mixerMONK per Header-Auswahl (2 Browser)', async ({ browser }) => {
  const ctxA = await newStudioContext(browser);
  const ctxB = await newStudioContext(browser);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    await openStudio(pageA);
    await openStudio(pageB);
    await expect(pageA.getByText(/SESSION 2\/4/)).toBeVisible({ timeout: 20_000 });

    // A wird Halter des mixerMONK (⋮-Menue = PRO + Lock).
    await pageA.getByLabel('mixerMONK Menü').click();
    await expect(pageA.locator('#rack-mixer').getByText('PRO').first()).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator('#rack-mixer').getByText('LOCKED · REMOTE')).toBeVisible({ timeout: 15_000 });

    // Die Uebergabe-Auswahl erscheint NUR beim Halter und nennt B als Ziel.
    const transferSelect = pageA.getByLabel('mixerMONK-Halter übergeben');
    await expect(transferSelect).toBeVisible({ timeout: 15_000 });
    const targetUserId = await transferSelect.locator('option').nth(1).getAttribute('value');
    expect(targetUserId, 'kein Uebergabe-Ziel in der Auswahl').toBeTruthy();

    await transferSelect.selectOption(targetUserId as string);

    // B ist jetzt der Halter: eigener Lock, Zustand PRO bleibt.
    await expect(pageB.locator('#rack-mixer').getByText('LOCKED · REMOTE')).toHaveCount(0, { timeout: 15_000 });
    await expect(pageB.locator('#rack-mixer').getByText('PRO').first()).toBeVisible();

    // A ist nicht mehr Halter: Auswahl verschwindet, A sieht den Fremd-Lock.
    await expect(transferSelect).toHaveCount(0, { timeout: 15_000 });
    await expect(pageA.locator('#rack-mixer').getByText('LOCKED · REMOTE')).toBeVisible({ timeout: 15_000 });

    // Und die Regel dahinter gilt weiter: B als NEUER Halter kann mixerMONK
    // trotzdem nicht schliessen (MIXER_NEVER_CLOSES) - der Power-Button bleibt
    // gesperrt. Genau das ist der Zweck des Haltermodells.
    await expect(pageB.getByLabel('mixerMONK Power')).toBeDisabled();
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

/**
 * COLLAB-P1-005: Der Main-Out-Pfad läuft nicht mehr am Server vorbei.
 * Der Halter (mixerMONK-Lock) bewegt den LEVEL-Regler; der Wert geht als
 * `main-out-update` an den Server, der ihn prüft (Allow-List + Bereich),
 * auditiert und an die anderen Session-User spiegelt - hier sichtbar am
 * gespiegelten Regler des zweiten Browsers und belegt über /api/audit.
 */
test('COLLAB-P1-005: Main-Out-Parameter laufen server-validiert und werden gespiegelt (2 Browser)', async ({ browser }) => {
  // Zwei Kontexte + Studio-Start + Spiegelung brauchen mehr als die Standard-30 s.
  test.setTimeout(120_000);
  const ctxA = await newStudioContext(browser);
  const ctxB = await newStudioContext(browser);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    await openStudio(pageA);
    await openStudio(pageB);
    await expect(pageA.getByText(/SESSION 2\/4/)).toBeVisible({ timeout: 20_000 });

    // A wird Halter des mixerMONK -> A ist damit der Main-Out-Owner.
    await pageA.getByLabel('mixerMONK Menü').click();
    await expect(pageB.locator('#rack-mixer').getByText('LOCKED · REMOTE')).toBeVisible({ timeout: 15_000 });

    // Eindeutiger Name: das Pult hat vier "LEVEL"-Regler (Master, Booth, Phones).
    const levelA = pageA.getByRole('slider', { name: 'Main-Out LEVEL' });
    const levelB = pageB.getByRole('slider', { name: 'Main-Out LEVEL' });
    const start = Number(await levelA.getAttribute('aria-valuenow'));
    expect(Number.isFinite(start), 'LEVEL-Regler ohne aria-valuenow').toBe(true);

    // Zwei Schritte hoch (Step 0.05 -> +10 Punkte im aria-Wert).
    await levelA.focus();
    await levelA.press('ArrowUp');
    await levelA.press('ArrowUp');
    const expected = Math.min(100, start + 10);
    await expect(levelA).toHaveAttribute('aria-valuenow', String(expected), { timeout: 10_000 });

    // Vorbedingung „A ist Main-Out-Owner" wird NICHT ueber den dev-only
    // Debug-Hook `__webRTCManager` geprueft (den gibt es im Produktions-Build
    // nicht - daran sind diese zwei Tests live und im lokalen Prod-Build
    // gescheitert). Produktionssichtbarer Beweis ist die Wirkung: nur der
    // Halter sendet `main-out-update`, der Server akzeptiert es und B spiegelt
    // den Wert. Genau das wird hier geprueft (Spiegelung + Audit unten).
    await expect(levelB).toHaveAttribute('aria-valuenow', String(expected), { timeout: 20_000 });

    // Und der Server hat den Vorgang gesehen: Audit-Eintrag mit param=wert.
    const token = studioToken();
    const audit = await fetch(`${studioBaseUrl()}/api/audit`, {
      headers: token ? { 'x-studio-token': token } : {},
    });
    expect(audit.ok, `Audit nicht abrufbar: ${audit.status}`).toBe(true);
    const body = (await audit.json()) as { entries?: { action?: string; ok?: boolean; target?: string }[] };
    const entries = (body.entries ?? []).filter((e) => e.action === 'MAIN_OUT_UPDATE');
    expect(entries.length, 'kein MAIN_OUT_UPDATE im Server-Audit').toBeGreaterThan(0);
    const accepted = entries.filter((e) => e.ok === true && String(e.target ?? '').startsWith('masterVolume='));
    expect(accepted.length, `kein akzeptierter masterVolume-Eintrag (${JSON.stringify(entries.slice(0, 5))})`).toBeGreaterThan(0);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
