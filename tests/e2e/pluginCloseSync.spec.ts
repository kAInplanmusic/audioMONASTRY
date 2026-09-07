import { test, expect, type Page } from '@playwright/test';
import { enterStudio, STUDIO_NAV } from './helpers/studioNav';

/**
 * P0-3-Prüfpunkt (Close-Button + State-Synchronisation):
 *  - Plugin-Terminal auf OFF stellen → Terminal verschwindet, Grid-Icon dunkel,
 *  - Power-Button des Rack-Streifens schließt genauso,
 *  - Reload → Zustand bleibt aus (Start-OFF-Regel aus P0-1).
 *
 * Die Peer-Replikation (`PLUGIN_STATE_UPDATE`) über mehrere Browser prüft
 * `tests/e2e/collab.spec.ts`; hier geht es um Terminal-UI und Persistenz.
 */
async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(page.locator(STUDIO_NAV).getByTitle('mixerMONK').first())
    .toBeVisible({ timeout: 15_000 });
}

const toolbarIcon = (page: Page, short: string) =>
  page.locator(STUDIO_NAV).getByTitle(short === 'MCP' ? 'mcpMONK' : short).first();

test('P0-3: OFF im Terminal schließt Plugin, Icon wird dunkel', async ({ page }) => {
  await openStudio(page);

  await toolbarIcon(page, 'MCP').click();
  const rack = page.locator('#rack-mcp');
  await expect(rack.locator('select').first()).toBeVisible({ timeout: 10_000 });
  await expect(toolbarIcon(page, 'MCP')).toHaveAttribute('aria-current', 'page');

  await rack.locator('select').first().selectOption('OFF');

  await expect(rack.locator('select')).toHaveCount(0);
  await expect(toolbarIcon(page, 'MCP')).not.toHaveAttribute('aria-current', /.+/);
  await expect(rack.getByText('OFF', { exact: true }).first()).toBeVisible();
});

test('P0-3: Power-Button des Rack-Streifens schließt das Terminal', async ({ page }) => {
  await openStudio(page);

  await toolbarIcon(page, 'MCP').click();
  const rack = page.locator('#rack-mcp');
  await expect(rack.locator('select').first()).toBeVisible({ timeout: 10_000 });

  await rack.getByLabel(/Power$/).click();

  await expect(rack.locator('select')).toHaveCount(0);
  await expect(toolbarIcon(page, 'MCP')).not.toHaveAttribute('aria-current', /.+/);
});

test('P0-3: Reload behält den OFF-Zustand (Start-OFF-Regel)', async ({ page }) => {
  await openStudio(page);

  await toolbarIcon(page, 'MCP').click();
  await expect(toolbarIcon(page, 'MCP')).toHaveAttribute('aria-current', 'page');
  await page.locator('#rack-mcp').locator('select').first().selectOption('OFF');
  await expect(toolbarIcon(page, 'MCP')).not.toHaveAttribute('aria-current', /.+/);

  await page.reload();
  await page.getByLabel('audioMONASTRY starten').click();
  await expect(toolbarIcon(page, 'MIX')).toBeVisible({ timeout: 15_000 });

  await expect(toolbarIcon(page, 'MCP')).not.toHaveAttribute('aria-current', /.+/);
  await expect(page.locator('#rack-mcp').locator('select')).toHaveCount(0);
});
