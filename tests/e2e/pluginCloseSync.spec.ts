import { test, expect, type Page } from '@playwright/test';
import { entryButton, STUDIO_NAV, modeButton, navButton, rackRow, switchPluginOn } from './helpers/studioNav';
import { resetSession } from './helpers/studioAuth';

test.beforeEach(async () => {
  await resetSession();
});

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
  await entryButton(page).click();
  await expect(page.locator(STUDIO_NAV).getByTitle('eqMONK').first())
    .toBeVisible({ timeout: 15_000 });
}

/** Holt und aktiviert eqMONK über den Modus-Button (OFF → STBY → ON). */
async function openEqRack(page: Page) {
  await navButton(page, 'EQ').click();
  await switchPluginOn(page, 'eq', 'eqMONK');
  return { rack: rackRow(page, 'eq'), mode: modeButton(page, 'eqMONK') };
}

test('P0-3: Modus-Button des Rack-Streifens schließt das Terminal (ON → OFF)', async ({ page }) => {
  await openStudio(page);
  const { rack, mode } = await openEqRack(page);

  // Terminal ist offen: das EQ-Panel rendert seine eigenen Bedienelemente.
  await expect(rack.locator('.am-sb')).toBeVisible();
  await expect(rack.locator('.am-sb button').first()).toBeVisible();

  await mode.click();

  await expect(rack).toHaveAttribute('data-plugin-mode', 'OFF');
  await expect(rack).toHaveAttribute('data-plugin-owner', 'none');
  await expect(rack.locator('.am-sb')).toHaveCount(0);
});

test('P0-3: Reload behält den OFF-Zustand (Start-OFF-Regel)', async ({ page }) => {
  await openStudio(page);
  const { rack, mode } = await openEqRack(page);
  await mode.click();
  await expect(rack).toHaveAttribute('data-plugin-mode', 'OFF');

  await page.reload();
  await entryButton(page).click();
  await expect(page.locator(STUDIO_NAV).getByTitle('eqMONK').first())
    .toBeVisible({ timeout: 15_000 });

  // Nach dem Reload ist eq OFF und frei - kein Terminal.
  const rackAfterReload = rackRow(page, 'eq');
  await expect(rackAfterReload.locator('select')).toHaveCount(0);
  await expect(rackAfterReload).toHaveAttribute('data-plugin-mode', 'OFF');
  await expect(rackAfterReload).toHaveAttribute('data-plugin-owner', 'none');
});
