import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { newStudioContext, resetSession } from './helpers/studioAuth';
import { entryButton } from './helpers/studioNav';

test.beforeEach(async () => { await resetSession(); });
test('all four local users have one manual aiMONK field and only Enter submits their own request', async ({ browser }) => {
  const contexts: BrowserContext[] = []; const pages: Page[] = []; const requests: string[][] = [[], [], [], []];
  try {
    for (let user = 0; user < 4; user++) {
      const context = await newStudioContext(browser); contexts.push(context);
      const page = await context.newPage(); pages.push(page);
      await page.route('**/api/ai/executor', async route => {
        requests[user].push(route.request().postDataJSON().task);
        // Explicit read-only fixture; no real planner, provider or write command.
        await route.fulfill({ json: { ok: true, provider: 'local-test-fixture', commands: [{ pluginId: 'eq', command: 'status' }] } });
      });
      await page.goto('/'); await entryButton(page).click();
      const dock = page.locator('#ai-monk-dock'); await expect(dock).toBeVisible();
      await expect(dock.getByRole('textbox')).toHaveCount(1);
      await expect(dock.getByRole('button')).toHaveCount(0);
      await expect(dock.locator('select')).toHaveCount(0);
      await expect(page.locator('#rack-ai')).toHaveCount(0);
      await dock.getByRole('textbox').fill(`Status von Nutzer ${user + 1}`);
    }
    expect(requests).toEqual([[], [], [], []]);
    for (let user = 0; user < 4; user++) {
      const field = pages[user].locator('#ai-monk-dock').getByRole('textbox');
      await field.press('Enter');
      await expect.poll(() => requests[user]).toEqual([`Status von Nutzer ${user + 1}`]);
      await expect(field).toHaveAttribute('aria-busy', 'false');
    }
    expect(requests.map(items => items.length)).toEqual([1, 1, 1, 1]);
    await pages[0].screenshot({ path: 'test-results/ai-monk-manual.png', fullPage: true });
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
