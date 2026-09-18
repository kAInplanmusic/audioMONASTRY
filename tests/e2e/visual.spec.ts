import { test, expect } from '@playwright/test';
import { STUDIO_NAV } from './helpers/studioNav';
import { resetSession } from './helpers/studioAuth';

/**
 * VISUAL-P1-010: Visuelle Baselines brauchen eine STEHENDE Seite. `animations:
 * 'disabled'` stoppt nur CSS - Uhrzeit, Session-Timer, Pegel und Canvas laufen
 * weiter, deshalb meldete Playwright 'Failed to take two consecutive stable
 * screenshots'. Mit eingefrorener Uhr (Playwright clock) und Uhrzeit-Fixpunkt
 * sind die Aufnahmen reproduzierbar.
 */
async function freezeTime(page: import('@playwright/test').Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-18T12:00:05Z'));
}

/**
 * Visuelle Regression (A/B-Baseline): Playwright `toHaveScreenshot` mit
 * committeten Baselines (tests/e2e/__screenshots__).
 *
 * Baselines aktualisieren:
 *   npx playwright test visual.spec.ts --update-snapshots
 *
 * Animationen werden für stabile Pixel-Vergleiche deaktiviert.
 *
 * Hinweis: Baselines gelten nur für den LOKALEN Dev-Server. Gegen entfernte
 * Instanzen (E2E_BASE_URL) wird der visuelle Vergleich übersprungen.
 */
test.skip(!!process.env.E2E_BASE_URL, 'Visuelle Baselines nur gegen den lokalen Dev-Server.');
test('Start-Screen Baseline', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // VISUAL-P1-010: Der Studio-Zustand haengt am SERVER (Modul-/Ansichts-State).
  // Ohne Reset screenshotet der Test je nach vorherigem Lauf eine andere Ansicht -
  // gemessen: Seitenhoehen 1679 px und 5446 px bei derselben Spec. Erst der Reset
  // macht die Baseline reproduzierbar.
  await resetSession();
  await freezeTime(page);
  await page.goto('/');
  await expect(page).toHaveTitle(/audioMONASTRY/);
  await expect(page).toHaveScreenshot('01-start-screen.png', {
    fullPage: true,
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
  });
});

test('Studio Baseline (Mixer + Modul-Grid)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await resetSession(); // siehe Start-Screen: reproduzierbare Ansicht
  await freezeTime(page);
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });
  // VISUAL-P1-010: Canvas und Live-Anzeigen aendern sich permanent (Visual-Feld,
  // Pegel, Uptime) - `animations: 'disabled'` stoppt nur CSS, nicht JS. Ohne Maske
  // meldet Playwright 'Failed to take two consecutive stable screenshots'.
  // VISUAL-P1-010: GEMESSEN - die Ganzseite ist nicht reproduzierbar (breite,
  // kleine Rasterisierungsabweichung, `animations: 'disabled'` hilft nicht).
  // `#rack-mixer` und `header` sind in drei aufeinanderfolgenden Aufnahmen
  // BYTE-IDENTISCH (scripts/visual-stability-probe.mjs). Verglichen werden daher
  // stabile Teilflaechen statt der ganzen Seite - der Aussagewert (Mixer-Layout,
  // Kopfzeile) bleibt, die Flakiness verschwindet.
  await expect(page.locator('#rack-mixer')).toHaveScreenshot('02-studio-mixer.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
    mask: [page.locator('[data-live-value]')],
  });
  await expect(page.locator('header').first()).toHaveScreenshot('02-studio-header.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
    mask: [page.locator('[data-live-value]'), page.locator('[role=status]')],
  });
});

/**
 * VISUAL-P1-010: Die Plugin-Ansichten werden aus dem DOM gelesen
 * (`data-plugin-id` am Nav-Knopf) statt aus einer gepflegten Liste. Die alte
 * Liste nannte Namen, die es nicht mehr gibt (`instrumentMONK` statt
 * `instruMONK`, `synthesizerMONK`/`drumMONK`/`samplerMONK` statt
 * `syntisamplerMONK`) — der Klick fand nie ein Element und lief in den
 * Test-Abbruch. Selbstwartend: neue/umbenannte Plugins erscheinen automatisch.
 */
async function pluginRowsFromNav(page: import('@playwright/test').Page): Promise<{ title: string; id: string }[]> {
  return page.locator(`${STUDIO_NAV} button[data-plugin-id]`).evaluateAll((buttons) =>
    buttons.map((b) => ({
      title: b.getAttribute('title') ?? '',
      id: b.getAttribute('data-plugin-id') ?? '',
    })).filter((r) => r.id));
}

test('P1-2: Screenshot-Baselines für alle 21 Plugin-/Sektions-Ansichten', async ({ page }) => {
  // 18 Ansichten mit asynchronem Rack-Inhalt: in dieser Umgebung dauert das je
  // nach Last 2-4 Minuten; 300 s rissen bei langsamen Laeufen (VISUAL-P1-010).
  test.setTimeout(420_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // KEINE eingefrorene Uhr: die Racks rendern ueber Timer - mit pausierter Uhr
  // kommt die Ansicht nicht voran (gemessen). Die Standbild-Baselines oben
  // brauchen sie dagegen, sonst sind sie nicht reproduzierbar.
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });

  // masterplayer (feste Sektion) + aiMONK (Bottom-Dock) sind immer sichtbar.
  await page.locator('#rack-masterplayer').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('03-plugin-masterplayer.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.06,
    mask: [page.locator('canvas')],
  });

  const toolbar = page.locator(STUDIO_NAV);
  const rows = await pluginRowsFromNav(page);
  expect(rows.length, 'Nav-Knoepfe mit data-plugin-id gefunden').toBeGreaterThan(10);
  for (const { id } of rows) {
    const btn = toolbar.locator(`button[data-plugin-id="${id}"]`).first();
    await btn.click();
    const rack = page.locator(`#rack-${id}`);
    await expect(rack).toBeVisible({ timeout: 20_000 });
    // Instrument-Terminal lädt seine Liste asynchron – erst abwarten, sonst
    // verschiebt sich der Rack-Inhalt zwischen den Screenshots.
    if (id.startsWith('instru')) {
      await expect(page.getByText(/Instrumente/)).toBeVisible({ timeout: 20_000 });
    }
    // Bilder im Terminal fertig laden, sonst reflowt das Rack zwischen den
    // beiden Stabilitäts-Screenshots (instabile Baseline).
    await rack.evaluate((el) => Promise.all(
      Array.from(el.querySelectorAll('img')).map((img) =>
        (img as HTMLImageElement).complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              (img as HTMLImageElement).onload = () => resolve();
              (img as HTMLImageElement).onerror = () => resolve();
            }),
      ),
    ));
    // VISUAL-P1-010: Racks laden Listen/Assets asynchron (Presets, Instrumente,
    // Samples). Vorher wurde nur beim Instrument-Rack gewartet - deshalb flackerte
    // die Ansicht 'syntisampler'. Jetzt generisch: warten, bis die Rack-HOEHE zwei
    // Messungen lang gleich bleibt (Inhalt fertig gerendert) und das Netz ruhig ist.
    // Bewusst SCHLANK: 18 Ansichten x Wartezeit kostete in dieser Umgebung den
    // Renderer ('Target page ... has been closed'). 6 Versuche a 250 ms genuegen
    // fuer die asynchronen Listen; kein `networkidle` (das haengt bei Dauer-Polls).
    let lastHeight = -1;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const box = await page.locator(`#rack-${id}`).boundingBox();
      const height = box?.height ?? -1;
      if (height > 0 && Math.abs(height - lastHeight) < 1) break;
      lastHeight = height;
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(400);
    await page.mouse.move(0, 0); // Hover-Highlights aus dem Weg räumen
    await page.waitForTimeout(200);
    await rack.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    // Teilflaeche statt Viewport (siehe Studio-Baseline): stabil und trotzdem
    // aussagekraeftig fuer das jeweilige Rack.
    await expect(rack).toHaveScreenshot(`03-plugin-${id}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.06,
      mask: [page.locator('canvas'), page.locator('[data-live-value]')],
    });
    await btn.click(); // wieder schließen (OFF)
  }

  await page.mouse.move(0, 0);
  await page.locator('#ai-monk-dock').evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  await expect(page.locator('#ai-monk-dock')).toHaveScreenshot('03-plugin-ai.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.06,
    mask: [page.locator('canvas'), page.locator('#ai-monk-dock div.max-h-28'), page.locator('[data-live-value]')],
  });
});
