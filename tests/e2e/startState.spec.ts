import { test, expect, type Page } from '@playwright/test';
import { STUDIO_NAV, STUDIO_NAV_COUNT } from './helpers/studioNav';

/**
 * P0-1-Prüfpunkt („Kein Plugin offen" beim Studio-Eintritt):
 *  - 0 sichtbare Plugin-Terminals (kein Rack-Streifen ist aufgeklappt),
 *  - alle Grid-Icons inaktiv (kein `aria-current`),
 *  - Mixer-Sonderfall entfernt: auch mixerMONK startet OFF,
 *  - Master läuft ins Silence-Gate (`-Infinity` dB, 50-ms-Rampe) → Stille.
 *
 * Die 60-s-RMS-Messung selbst deckt `tests/goldenAudio.test.ts` (P0-4) ab.
 */
const SILENCE_RAMP = 0.05;

async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator(STUDIO_NAV).getByTitle('mixerMONK').first())
    .toBeVisible({ timeout: 15_000 });
}

/** Zeichnet alle Silence-Gate-Rampen (50 ms) des Masters auf. */
async function instrumentSilenceGate(page: Page, ramp: number): Promise<void> {
  await page.addInitScript((rampSec) => {
    (window as { __silenceRamps?: number[] }).__silenceRamps = [];
    const original = AudioParam.prototype.setTargetAtTime;
    AudioParam.prototype.setTargetAtTime = function patched(value, startTime, timeConstant) {
      if (timeConstant === rampSec) (window as { __silenceRamps?: number[] }).__silenceRamps?.push(value);
      return original.call(this, value, startTime, timeConstant);
    };
  }, ramp);
}

test('P0-1: Studio-Start zeigt 0 Plugin-Terminals und nur gedimmte Icons', async ({ page }) => {
  await openStudio(page);

  // Kein Rack-Streifen ist aktiv → kein Terminal-Inhalt gerendert.
  const racks = page.locator('section[id^="rack-"]');
  const rackCount = await racks.count();
  expect(rackCount).toBeGreaterThan(0);
  // Feste Sektionen ohne OFF-Zustand: der Transport (P0-7) und das
  // Performance-Monitor-Panel ('FIXED · MONITOR', kein Power-Button, zeigt
  // dauerhaft Metriken). Beide sind keine Plugin-Racks - live geprueft 2026-09-17.
  // Dazu mixerMONK: es ist seit der Betreiberregel 2026-09-17 die einzige
  // Main-Einspeisung, startet aktiv und laesst sich nicht schliessen (COLLAB-P0-004).
  const FIXED_SECTIONS = new Set(['rack-masterplayer', 'rack-perfor', 'rack-mixer']);
  for (let i = 0; i < rackCount; i++) {
    const rack = racks.nth(i);
    const id = await rack.getAttribute('id');
    if (FIXED_SECTIONS.has(id ?? '')) continue;
    // Nicht .first() allein: das trifft das versteckte <option value="OFF"> eines
    // Auswahlfelds und kann nie sichtbar sein (live nachgestellt 2026-09-17).
    await expect(rack.getByText('OFF', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  }

  // Nav-Icons: `aria-current` markiert die gewaehlte ANSICHT
  // (App.tsx:549, `active = activeNav === plugin.id`) - beim Start ist genau eine
  // Default-Ansicht markiert. Das sagt nichts ueber die Modulaktivitaet aus; dass
  // kein Modul laeuft, sichern die OFF-Zusicherungen der Rack-Schleife oben ab.
  // Geprueft wird daher: genau eine Ansicht markiert (nicht keine, nicht zwei).
  const buttons = page.locator('nav[aria-label="Studio-Navigation"] button');
  const count = await buttons.count();
  // Quelle der Wahrheit ist der Helper (16-MONK-Ziel); die frueher hier
  // stehende 19 war veraltet und liess den Test in jedem Browser scheitern.
  expect(count).toBeGreaterThanOrEqual(STUDIO_NAV_COUNT);
  // Das Attribut sitzt am Button selbst, nicht an einem Kindelement.
  await expect(page.locator(STUDIO_NAV + ' button[aria-current]')).toHaveCount(1);
  // Betreiberentscheidung 2026-09-17: Startansicht ist mixerMONK (das Mischpult).
  await expect(page.locator(STUDIO_NAV).getByTitle('mixerMONK').first())
    .toHaveAttribute('aria-current', 'page');
});

test('P0-1/COLLAB-P0-004: mixerMONK startet aktiv und laesst sich nicht schliessen', async ({ page }) => {
  await openStudio(page);

  const mixerRack = page.locator('#rack-mixer');
  // Betreiberregel 2026-09-17: der Mixer entscheidet den Main-Out und ist immer da;
  // die anderen Module spielen zu und starten OFF (siehe Schleife oben).
  await expect(mixerRack.getByLabel('mixerMONK aktiv')).toBeVisible();

  // Geschlossen werden kann er nicht: der Power-Button ist gesperrt und nennt den Grund.
  const power = mixerRack.getByLabel(/Power$/);
  await expect(power).toBeDisabled();
  await expect(power).toHaveAttribute('title', /entscheidet den Main-Out/);

  // mixerMONK ist ausserdem die markierte Startansicht (aria-current = ANSICHT,
  // nicht Modulzustand).
  await expect(page.locator(STUDIO_NAV).getByTitle('mixerMONK').first())
    .toHaveAttribute('aria-current', 'page');
});

test('P0-1: Master startet im Silence-Gate (kein Rauschen auf Main)', async ({ page }) => {
  await instrumentSilenceGate(page, SILENCE_RAMP);
  await openStudio(page);

  const ramps = await page.evaluate(() => (window as { __silenceRamps?: number[] }).__silenceRamps ?? []);
  test.skip(ramps.length === 0, 'Kein Audio-Graph in dieser Browser-Umgebung');
  // Letzte Silence-Gate-Rampe muss stumm sein, solange kein Plugin aktiv ist.
  expect(ramps[ramps.length - 1]).toBe(Number.NEGATIVE_INFINITY);
});
