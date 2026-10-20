import { test, expect } from '@playwright/test';
import { entryButton, STUDIO_NAV, switchPluginOn, switchPluginOff } from './helpers/studioNav';
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
  // VISUAL-P1-014: `fullPage: true` ist der flaky Punkt. Die Startseite laedt
  // asynchron (Modul-Grid, AI-Dock, Live-Pegel), die Hoehe schwankt zwischen
  // Captures um 10-15 px und Playwright meldet 'Failed to take two consecutive
  // stable screenshots'. GEMESSEN 2026-10-12: 3x3-Lauf mit fullPage -> 2/3 rot,
  // mit Teilflaeche -> 3x3 gruen. Dasselbe Prinzip wie die Studio-Baseline:
  // stabile Teilflaechen statt der ganzen Seite, dynamische Bereiche maskiert.
  await expect(page.locator('#root')).toHaveScreenshot('01-start-screen.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
    mask: [page.locator('[data-live-value]'), page.locator('[role=status]')],
  });
});

test('Studio Baseline (Mixer + Modul-Grid)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await resetSession(); // siehe Start-Screen: reproduzierbare Ansicht
  await page.goto('/');
  await entryButton(page).click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });
  // BEFUND 2026-09-29 (Vollauf vs. Einzellauf): Das Mixer-Rack wird asynchron
  // geladen. Die alte Baseline (147 px) hielt den LADEZUSTAND fest – bei warmem
  // Modul rendert dasselbe Rack 2779 px, und der Vergleich schlug je nach
  // Laufumgebung fehl (gemessen: 3 160 130 px = 91 % Unterschied).
  // Deshalb erst auf den GELADENEN Mixer warten – Kriterium ist die Rack-Hoehe
  // (> 400 px; Ladezustand ~147 px), NICHT ein Textknoten.
  const mixerRack = page.locator('#rack-mixer');
  await expect
    .poll(async () => (await mixerRack.boundingBox())?.height ?? 0, { timeout: 20_000, intervals: [250] })
    .toBeGreaterThan(400);
  let letzteHoehe = -1;
  for (let i = 0; i < 8; i += 1) {
    const hoehe = (await mixerRack.boundingBox())?.height ?? -1;
    if (hoehe > 0 && Math.abs(hoehe - letzteHoehe) < 1) break;
    letzteHoehe = hoehe;
    await page.waitForTimeout(250);
  }
  // Uhr erst JETZT einfrieren – Timer-getriebene Module müssen vorher geladen sein.
  // Vorher freezeTime blockierte das asynchrone Laden (UI2-P1-001 Befund: 80-143 px
  // statt 2779 px). Erst nach Stabilisierung pausieren für reproduzierbaren Screenshot.
  await freezeTime(page);

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
    // Lock-Icons faerben sich je Lock-Zustand/Owner um (gemessen 2026-10-17:
    // ~0.05 Ratio trotz reducedMotion + Reset, Lock-Vergabe ist nicht
    // deterministisch) - die Toleranz gibt das frei, Struktur bleibt bewacht.
    maxDiffPixelRatio: 0.08,
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
  // P1-2-Befund 2026-10-18: Jede Ansicht wird jetzt VOR der Aufnahme auf ON
  // geschaltet (Terminal-Inhalt existiert erst bei ON) und danach wieder
  // freigegeben - gemessen 7,2 min. 420 s rissen deshalb VOR dem Ende.
  test.setTimeout(720_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // KEINE eingefrorene Uhr: die Racks rendern ueber Timer - mit pausierter Uhr
  // kommt die Ansicht nicht voran (gemessen). Die Standbild-Baselines oben
  // brauchen sie dagegen, sonst sind sie nicht reproduzierbar.
  await page.goto('/');
  await entryButton(page).click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 20_000 });

  // mastergraph (feste Sektion) + aiMONK (Bottom-Dock) sind immer sichtbar.
  await page.locator('#rack-mastergraph').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('03-plugin-mastergraph.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.06,
    mask: [page.locator('canvas')],
  });

  const toolbar = page.locator(STUDIO_NAV);
  const rows = await pluginRowsFromNav(page);
  expect(rows.length, 'Nav-Knoepfe mit data-plugin-id gefunden').toBeGreaterThan(10);
  // P1-2-Befund 2026-10-18: Der Modus-Klick im Loop ist ein NAVIGATIONS-Klick,
  // kein Moduswechsel - je Row blieb das Rack im OFF-Zustand und renderte nur
  // den 47-px-Head-Strip (DOM-Snapshot: alle Racks "frei · OFF", Selects/Buttons
  // disabled). Der Terminal-Inhalt (Instrument-Select, Preset-Listen, Canvas)
  // existiert erst bei Modus ON (pluginPanelOpen: ON + owner === me). Der
  // Screenshot-Lauf fiel dadurch komplett leer; instru wartete 30 s auf ein
  // Select, das bei OFF nie erscheint. Deshalb: JEDES freie Rack vor der
  // Aufnahme auf ON schalten (OFF → STBY → ON, Muster aus noDeviceStorage) und
  // NACH dem Screenshot wieder freigeben, damit der Session-State nicht anläuft.
  for (const { title, id } of rows) {
    // title am Nav-Knopf ist "<Name> · <Status>" (App.tsx) - der Modus-Button
    // spricht nur den Namen an ("instruMONK Modus OFF").
    const name = title.split('·')[0].trim();
    const btn = toolbar.locator(`button[data-plugin-id="${id}"]`).first();
    await btn.click(); // Ansicht wählen (Nav-Klick)
    const rack = page.locator(`#rack-${id}`);
    await expect(rack).toBeVisible({ timeout: 20_000 });
    const mode = (await rack.getAttribute('data-plugin-mode')) ?? '';
    const owner = (await rack.getAttribute('data-plugin-owner')) ?? '';
    // E2E-2026-10-20-001 (biblio 1248x47 statt 1248x342): 'ON' heisst NICHT
    // "Bedienfläche offen" - pluginPanelOpen (src/core/session/pluginMode.ts)
    // verlangt ON + owner === me. Vorher laufende Specs lassen den Modul-State
    // PRO ohne Freigabe zurueck (audioAction.spec.ts holt biblio und gibt nie
    // frei; der Lock faellt beim Disconnect, server/realtime.ts) - uebrig bleibt
    // "ON ohne Halter" (data-plugin-owner="none", Summary "Läuft ohne Halter",
    // 47-px-Head-Strip, Aufklappen disabled; Beweis: error-context.md des
    // Fehllaufs). Der Zustand ueberlebt Kontexte und Server-Neustarts
    // (data/state/session-state.json) und /api/session/reset ist ohne
    // AUDIOMONASTRY_TEST_RESET=1 ein 404, den studioAuth stillschweigend
    // ueberspringt. switchPluginOn heilt ihn: Klick 1 holt den Lock und setzt
    // PRO auf OFF (cycleMode => STBY), Klick 2 aktiviert (=> ON, owner me).
    if (mode !== 'ON' || owner !== 'me') {
      // mixerMONK ist immer ON (UI2-P0-001); alles andere muss erst geholt und
      // aktiviert werden - erst dann rendert das Rack seine Bedienfläche.
      await switchPluginOn(page, id, name);
    }
    // Extra-Assertion: das Rack muss VOR der Aufnahme von MIR gehalten UND ON
    // sein - erst dann rendert das Terminal (owner='me' ist exakt
    // pluginPanelOpen; Fehllauf 2026-10-20: biblio ON mit owner "none" = 47px).
    await expect(rack).toHaveAttribute('data-plugin-mode', 'ON', { timeout: 15_000 });
    await expect(rack).toHaveAttribute('data-plugin-owner', 'me', { timeout: 15_000 });
    // Instrument-Terminal lädt seine Liste asynchron – erst abwarten, sonst
    // verschiebt sich der Rack-Inhalt zwischen den Screenshots.
    if (id.startsWith('instru')) {
      // Der Katalog laedt asynchron; der Zaehler steht im <option>-Text des
      // Instrument-Selects ('N Instrumente – waehlen ...') - erst das Select,
      // dann die geladene Optionsliste abwarten.
      const instSel = page.locator('#rack-instru select[aria-label="Instrument wählen"]');
      await expect(instSel).toBeVisible({ timeout: 30_000 });
      await expect(instSel.locator('option[value=""]')).toContainText('Instrumente', { timeout: 30_000 });
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
    // mixerMONK ist nicht schliessbar (UI2-P0-001, Modus-Button disabled) -
    // alles andere geben wir frei, damit der Session-State nicht anläuft.
    if (id !== 'mixer') {
      await switchPluginOff(page, id, name); // ON → OFF: Lock freigeben (Nav-Klick allein schließt nicht)
    }
  }

  await page.mouse.move(0, 0);
  await page.locator('#ai-monk-dock').evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  await expect(page.locator('#ai-monk-dock')).toHaveScreenshot('03-plugin-ai.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.06,
    mask: [page.locator('canvas'), page.locator('#ai-monk-dock div.max-h-28'), page.locator('[data-live-value]')],
  });
});
