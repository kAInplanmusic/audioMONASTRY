import { test, expect, type Page } from '@playwright/test';
import { STUDIO_NAV, navButton } from './helpers/studioNav';

/**
 * P0-3-Prüfpunkt (Close-Button + State-Synchronisation):
 *  - Plugin-Terminal schließen → Terminal verschwindet, Rack zeigt OFF,
 *  - dasselbe über den Power-Button des Rack-Streifens,
 *  - Reload → Zustand bleibt aus (Start-OFF-Regel aus P0-1).
 *
 * Die Peer-Replikation (`PLUGIN_STATE_UPDATE`) über mehrere Browser prüft
 * `tests/e2e/collab.spec.ts`; hier geht es um Terminal-UI und Persistenz.
 *
 * Modernisiert 2026-09-17 (CI-P1-002): der Spec lief gegen `#rack-mcp` und
 * `getByTitle('mcpMONK')` - Plugin und Plugin-Toolbar wurden beim UI-Refactor
 * entfernt, der Klick lief deshalb in den Timeout. Geprüft wird jetzt an einem
 * bestehenden Plugin (mixerMONK) mit den heutigen Bedienelementen:
 *   - Terminal-intern: `aria-label="… schließen (OFF)"` (ModuleContainer)
 *   - Rack-Kopf: `aria-label="… Power"` zum Schließen (RackRow)
 * Den Zustand trägt der Icon-Button des Racks: `aria-pressed` plus Label
 * "<name> aktiv"/"<name> inaktiv" - der Power-Button selbst hat kein aria-pressed.
 * `aria-current` markiert die gewählte ANSICHT (App.tsx:549, activeNav), nicht die
 * Modulaktivität; dass ein Modul aus ist, prüfen wir über das Zustandslabel und das
 * sichtbare OFF.
 */
async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator(STUDIO_NAV).getByTitle('mixerMONK').first())
    .toBeVisible({ timeout: 15_000 });
}

/** Aktiviere mixerMONK über die Navigation und liefere Rack + Power-Button. */
async function openMixerRack(page: Page) {
  await navButton(page, 'MIX').click();
  const rack = page.locator('#rack-mixer');
  await expect(rack.getByLabel('mixerMONK aktiv')).toBeVisible({ timeout: 10_000 });
  return { rack, power: rack.getByLabel(/Power$/) };
}

test('P0-3: Terminal-Schließen beendet das Plugin, Rack zeigt OFF', async ({ page }) => {
  await openStudio(page);
  const { rack, power } = await openMixerRack(page);

  // Terminal ist offen: der generische Schließen-Button ist da.
  await expect(rack.getByLabel(/schließen \(OFF\)/).first()).toBeVisible();

  await rack.getByLabel(/schließen \(OFF\)/).first().click();

  await expect(rack.getByLabel('mixerMONK inaktiv')).toBeVisible();
  await expect(rack.getByLabel(/schließen \(OFF\)/)).toHaveCount(0);
  // Siehe startState.spec.ts: die <option value="OFF"> ist nie sichtbar.
  await expect(rack.getByText('OFF', { exact: true }).filter({ visible: true }).first()).toBeVisible();
});

test('P0-3: Power-Button des Rack-Streifens schließt das Terminal', async ({ page }) => {
  await openStudio(page);
  const { rack, power } = await openMixerRack(page);

  await expect(rack.getByLabel(/schließen \(OFF\)/).first()).toBeVisible();

  await power.click();

  await expect(power).toHaveAttribute('aria-pressed', 'false');
  await expect(rack.getByLabel(/schließen \(OFF\)/)).toHaveCount(0);
  await expect(rack.getByText('OFF', { exact: true }).filter({ visible: true }).first()).toBeVisible();
});

test('P0-3: Reload behält den OFF-Zustand (Start-OFF-Regel)', async ({ page }) => {
  await openStudio(page);
  const { power } = await openMixerRack(page);
  await power.click();
  await expect(rack.getByLabel('mixerMONK inaktiv')).toBeVisible();

  await page.reload();
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator(STUDIO_NAV).getByTitle('mixerMONK').first())
    .toBeVisible({ timeout: 15_000 });

  // Nach dem Reload startet alles OFF - kein Terminal, sichtbares OFF im Rack.
  const rack = page.locator('#rack-mixer');
  await expect(rack.getByLabel(/schließen \(OFF\)/)).toHaveCount(0);
  await expect(rack.getByLabel('mixerMONK inaktiv')).toBeVisible();
  await expect(rack.getByText('OFF', { exact: true }).filter({ visible: true }).first()).toBeVisible();
});
