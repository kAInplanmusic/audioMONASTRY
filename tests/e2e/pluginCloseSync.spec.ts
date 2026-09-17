import { test, expect, type Page } from '@playwright/test';
import { STUDIO_NAV, navButton } from './helpers/studioNav';

/**
 * P0-3-Prüfpunkt (Schließen + State):
 *  - Power-Button des Rack-Streifens schließt das Terminal,
 *  - Reload → Zustand bleibt aus (Start-OFF-Regel aus P0-1).
 *
 * Die Peer-Replikation (`PLUGIN_STATE_UPDATE`) über mehrere Browser prüft
 * `tests/e2e/collab.spec.ts`; hier geht es um Terminal-UI und Persistenz.
 *
 * Modernisiert 2026-09-17 (CI-P1-002) - mit Belegen, nicht aus Vermutung:
 *  - Der Spec lief gegen `#rack-mcp`/`getByTitle('mcpMONK')`. Plugin und
 *    Plugin-Toolbar wurden beim UI-Refactor entfernt, der Klick lief in den Timeout.
 *  - Geprüft wird an eqMONK, bewusst NICHT an mixerMONK: mixer/master sind
 *    Main-Out-Plugins und dürfen laut src/core/session/mainOutGuard.ts nur vom
 *    jeweiligen Lock-Owner geschaltet werden. Ohne Session existiert kein Halter,
 *    deshalb bricht ModuleStateContext.tsx:59 vor dem lokalen Setzen ab - mixerMONK
 *    bleibt zwangsläufig OFF (live nachgestellt: Rack blieb „mixerMONK inaktiv").
 *  - Der frühere Weg „OFF im Terminal" (Schließen-Button aus ModuleContainer) ist
 *    entfallen: ModuleContainer wird nirgends importiert, der Button also nie
 *    gerendert. Der Rack-Power-Button ist heute der einzige Schließweg.
 *  - Zustand wird über das Label „eqMONK aktiv/inaktiv" geprüft: `aria-pressed`
 *    sitzt am Icon-Button des Racks, der Power-Button hat keins.
 *  - `aria-current` markiert die gewählte ANSICHT (App.tsx, activeNav), nicht die
 *    Modulaktivität.
 */
async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator(STUDIO_NAV).getByTitle('eqMONK').first())
    .toBeVisible({ timeout: 15_000 });
}

/** Aktiviere eqMONK über die Navigation und liefere Rack + Power-Button. */
async function openEqRack(page: Page) {
  await navButton(page, 'EQ').click();
  const rack = page.locator('#rack-eq');
  await expect(rack.getByLabel('eqMONK aktiv')).toBeVisible({ timeout: 10_000 });
  return { rack, power: rack.getByLabel(/Power$/) };
}

test('P0-3: Power-Button des Rack-Streifens schließt das Terminal', async ({ page }) => {
  await openStudio(page);
  const { rack, power } = await openEqRack(page);

  // Terminal ist offen: das EQ-Panel rendert seine eigenen Bedienelemente.
  await expect(rack.locator('select').first()).toBeVisible();

  await power.click();

  await expect(rack.getByLabel('eqMONK inaktiv')).toBeVisible();
  await expect(rack.locator('select')).toHaveCount(0);
  // Siehe startState.spec.ts: die <option value="OFF"> ist nie sichtbar.
  await expect(rack.getByText('OFF', { exact: true }).filter({ visible: true }).first()).toBeVisible();
});

test('P0-3: Reload behält den OFF-Zustand (Start-OFF-Regel)', async ({ page }) => {
  await openStudio(page);
  const { rack, power } = await openEqRack(page);
  await power.click();
  await expect(rack.getByLabel('eqMONK inaktiv')).toBeVisible();

  await page.reload();
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator(STUDIO_NAV).getByTitle('eqMONK').first())
    .toBeVisible({ timeout: 15_000 });

  // Nach dem Reload startet alles OFF - kein Terminal, sichtbares OFF im Rack.
  const rackAfterReload = page.locator('#rack-eq');
  await expect(rackAfterReload.locator('select')).toHaveCount(0);
  await expect(rackAfterReload.getByLabel('eqMONK inaktiv')).toBeVisible();
  await expect(rackAfterReload.getByText('OFF', { exact: true }).filter({ visible: true }).first()).toBeVisible();
});
