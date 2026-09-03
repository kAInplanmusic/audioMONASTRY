import { test, expect, type Page } from '@playwright/test';

/**
 * P0-1-Prüfpunkt („Kein Plugin offen" beim Studio-Eintritt):
 *  - 0 sichtbare Plugin-Terminals (kein Rack-Streifen ist aufgeklappt),
 *  - alle Grid-Icons gedimmt (`aria-pressed="false"`),
 *  - Mixer-Sonderfall entfernt: auch mixerMONK startet OFF,
 *  - Master läuft ins Silence-Gate (`-Infinity` dB, 50-ms-Rampe) → Stille.
 *
 * Die 60-s-RMS-Messung selbst deckt `tests/goldenAudio.test.ts` (P0-4) ab.
 */
const SILENCE_RAMP = 0.05;

async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('MIX').first())
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
  await enterStudio(page);

  // Kein Rack-Streifen ist aktiv → kein Terminal-Inhalt gerendert.
  const racks = page.locator('section[id^="rack-"]');
  const rackCount = await racks.count();
  expect(rackCount).toBeGreaterThan(0);
  for (let i = 0; i < rackCount; i++) {
    const rack = racks.nth(i);
    const id = await rack.getAttribute('id');
    if (id === 'rack-masterplayer') continue; // feste Transport-Sektion (P0-7)
    await expect(rack.getByText('OFF', { exact: true }).first()).toBeVisible();
  }

  // Toolbar-Icons sind alle gedimmt.
  const buttons = page.locator('nav[aria-label="Plugin-Toolbar"] button[aria-pressed]');
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(19);
  for (let i = 0; i < count; i++) {
    await expect(buttons.nth(i)).toHaveAttribute('aria-pressed', 'false');
  }
});

test('P0-1: Mixer-Sonderfall entfernt – mixerMONK startet OFF', async ({ page }) => {
  await enterStudio(page);

  const mixerRack = page.locator('#rack-mixer');
  await expect(mixerRack.getByText('OFF', { exact: true }).first()).toBeVisible();
  await expect(page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('MIX').first())
    .toHaveAttribute('aria-pressed', 'false');
});

test('P0-1: Master startet im Silence-Gate (kein Rauschen auf Main)', async ({ page }) => {
  await instrumentSilenceGate(page, SILENCE_RAMP);
  await enterStudio(page);

  const ramps = await page.evaluate(() => (window as { __silenceRamps?: number[] }).__silenceRamps ?? []);
  test.skip(ramps.length === 0, 'Kein Audio-Graph in dieser Browser-Umgebung');
  // Letzte Silence-Gate-Rampe muss stumm sein, solange kein Plugin aktiv ist.
  expect(ramps[ramps.length - 1]).toBe(Number.NEGATIVE_INFINITY);
});
