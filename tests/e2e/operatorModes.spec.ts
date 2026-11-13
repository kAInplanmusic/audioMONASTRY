import { test, expect } from '@playwright/test';
import { newStudioContext, resetSession } from './helpers/studioAuth';
import { entryButton, rackRow, switchPluginOn, switchPluginOff } from './helpers/studioNav';

test.beforeEach(async () => { await resetSession(); });
test('operator modes replicate with ownership; aiMONK stays open for both users', async ({ browser }) => {
  const a = await newStudioContext(browser), b = await newStudioContext(browser);
  try {
    const one = await a.newPage(), two = await b.newPage();
    for (const page of [one, two]) {
      await page.goto('/'); await entryButton(page).click();
      await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 30000 });
      const dock = page.locator('#ai-monk-dock');
      await expect(dock).toBeVisible();
      await expect(dock.locator('select')).toHaveCount(0);
      await expect(dock.getByRole('button', { name: /Modus|PRO|zuklappen|aufklappen/ })).toHaveCount(0);
      await expect(page.locator('#rack-ai')).toHaveCount(0);
    }
    await switchPluginOn(one, 'eq', 'eqMONK');
    await expect(rackRow(two, 'eq')).toHaveAttribute('data-plugin-mode', 'ON');
    await expect(rackRow(two, 'eq')).toHaveAttribute('data-plugin-owner', 'other');
    for (const label of ['Aus', 'An', 'KI-gesteuert']) {
      await expect(two.getByRole('button', { name: `eqMONK ${label}`, exact: true })).toBeDisabled();
    }
    await one.getByRole('button', { name: 'eqMONK KI-gesteuert', exact: true }).click();
    await expect(rackRow(one, 'eq')).toHaveAttribute('data-plugin-mode', 'AI');
    await expect(rackRow(two, 'eq')).toHaveAttribute('data-plugin-mode', 'AI');
    await one.getByRole('button', { name: 'eqMONK zuklappen', exact: true }).click();
    await expect(rackRow(one, 'eq').locator('.am-sb')).toHaveCount(1);
    await expect(rackRow(one, 'eq').locator('.am-sb')).toBeHidden();
    await switchPluginOff(one, 'eq', 'eqMONK');
    await expect(rackRow(two, 'eq')).toHaveAttribute('data-plugin-mode', 'OFF');
    await expect(rackRow(two, 'eq')).toHaveAttribute('data-plugin-owner', 'none');
    await switchPluginOn(two, 'eq', 'eqMONK');
    await expect(rackRow(one, 'eq')).toHaveAttribute('data-plugin-owner', 'other');
    await one.screenshot({ path: 'test-results/operator-modes.png', fullPage: true });
    await switchPluginOff(two, 'eq', 'eqMONK');
    for (const page of [one, two]) await expect(page.locator('#ai-monk-dock')).toBeVisible();
  } finally { await a.close(); await b.close(); }
});

test('rapid An then KI selection waits for one authority claim and applies only the final intent', async ({ page }) => {
  await page.goto('/'); await entryButton(page).click();
  await expect(page.getByTitle('mixerMONK').first()).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => {
    for (const name of ['eqMONK An', 'eqMONK KI-gesteuert']) {
      (document.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement).click();
    }
  });
  await expect(rackRow(page, 'eq')).toHaveAttribute('data-plugin-mode', 'AI');
  await expect(rackRow(page, 'eq')).toHaveAttribute('data-plugin-owner', 'me');
  await switchPluginOff(page, 'eq', 'eqMONK');
});
