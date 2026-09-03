import { test, expect, type Page } from '@playwright/test';

/**
 * P0-6-Prüfpunkt (Main-/Monitor-Routing): Der Cue-Weg eines Users schaltet
 * ausschließlich seinen **lokalen** Abhörweg um – der MAIN-Bus (und damit der
 * Mix der übrigen bis zu 3 User sowie der Master-Stream) bleibt unverändert.
 *
 * Gemessen wird auf Web-Audio-Ebene: `audioEngine.applyMonitorPlan()` fährt
 * MAIN-Monitor-Gain, Cue-Gain und die Cue-Kanal-Gains mit der Zeitkonstante
 * 10 ms (`setTargetAtTime(..., 0.01)`). Genau diese Aufrufe werden mitgeloggt,
 * andere Rampen der Engine (Kanal-Fader 30 ms, Silence-Gate 50 ms,
 * Spatial-Blende 20 ms) fallen nicht in den Filter.
 *
 * Die 4-Browser-Replikation der Plugin-Zustände deckt `collab.spec.ts` ab.
 */
const CUE_RAMP = 0.01;

async function enterStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('MIX').first())
    .toBeVisible({ timeout: 15_000 });
}

/** Zeichnet alle Cue-Rampen (10 ms) des lokalen Abhörwegs auf. */
async function instrumentCueRamps(page: Page, ramp: number): Promise<void> {
  await page.addInitScript((rampSec) => {
    (window as { __cueRamps?: number[] }).__cueRamps = [];
    const original = AudioParam.prototype.setTargetAtTime;
    AudioParam.prototype.setTargetAtTime = function patched(value, startTime, timeConstant) {
      if (timeConstant === rampSec) (window as { __cueRamps?: number[] }).__cueRamps?.push(value);
      return original.call(this, value, startTime, timeConstant);
    };
  }, ramp);
}

const readRamps = (page: Page) => page.evaluate(() => {
  const w = window as { __cueRamps?: number[] };
  const values = w.__cueRamps ?? [];
  w.__cueRamps = [];
  return values;
});

test('P0-6: PLUGIN-Cue solo, MAIN unverändert, zurück auf MAIN = sofort Gesamtmix', async ({ page }) => {
  await instrumentCueRamps(page, CUE_RAMP);
  await enterStudio(page);

  // Plugin aktivieren (drumMONK speist MAIN über seinen Kanal).
  await page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('DRM').first().click();
  await expect(page.locator('nav[aria-label="Plugin-Toolbar"]').getByTitle('DRM').first())
    .toHaveAttribute('aria-pressed', 'true');

  // Abhörweg von User 3 wählen; Startzustand ist MAIN + PLUGIN.
  await page.getByLabel('Monitor-User wählen').selectOption('MON3');
  const cueButton = page.getByTitle(/Monitor-Mix für USER 3/);
  await expect(cueButton).toHaveAttribute('aria-pressed', 'false');
  await readRamps(page);

  // NUR PLUGIN: lokaler MAIN-Monitor zu, Cue auf, genau ein Kanal im Cue offen.
  await cueButton.click();
  await expect(cueButton).toHaveAttribute('aria-pressed', 'true');
  const onRamps = await readRamps(page);
  expect(onRamps.length).toBeGreaterThanOrEqual(3);
  expect(onRamps[0]).toBe(0);            // lokaler MAIN-Abhörpegel
  expect(onRamps[1]).toBe(1);            // Cue-Bus des Users
  expect(onRamps.slice(2).filter((v) => v > 0)).toHaveLength(1);

  // Zurück auf MAIN: sofort wieder Gesamtmix (alle Cue-Kanäle offen, Cue zu).
  await cueButton.click();
  await expect(cueButton).toHaveAttribute('aria-pressed', 'false');
  const offRamps = await readRamps(page);
  expect(offRamps.length).toBeGreaterThanOrEqual(3);
  expect(offRamps[0]).toBe(1);           // lokaler MAIN-Abhörpegel wieder offen
  expect(offRamps[1]).toBe(0);           // Cue stumm
  expect(offRamps.slice(2).every((v) => v > 0)).toBe(true);
});

test('P0-6: Cue-Auswahl bleibt pro User getrennt (kein State-Übergriff)', async ({ page }) => {
  await enterStudio(page);

  await page.getByLabel('Monitor-User wählen').selectOption('MON3');
  await page.getByTitle(/Monitor-Mix für USER 3/).click();
  await expect(page.getByTitle(/Monitor-Mix für USER 3/)).toHaveAttribute('aria-pressed', 'true');

  // Die übrigen Session-User bleiben auf MAIN + PLUGIN.
  for (const [value, label] of [['MON1', 'USER 1'], ['MON2', 'USER 2'], ['MON4', 'USER 4']]) {
    await page.getByLabel('Monitor-User wählen').selectOption(value);
    await expect(page.getByTitle(new RegExp(`Monitor-Mix für ${label}`)))
      .toHaveAttribute('aria-pressed', 'false');
  }

  await page.getByLabel('Monitor-User wählen').selectOption('MON3');
  await expect(page.getByTitle(/Monitor-Mix für USER 3/)).toHaveAttribute('aria-pressed', 'true');
});
