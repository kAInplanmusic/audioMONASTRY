import { test, expect } from '@playwright/test';
import fs from 'node:fs';

/**
 * R17 Beleg: DJ-Anfrage, Countdown beim Halter, automatischer Takeover nach 5 s.
 * Läuft gegen einen bereits laufenden Dev-Server (R17_BASE_URL).
 */
test('R17 DJ override: request, holder countdown, automatic takeover', async ({ browser }) => {
  test.setTimeout(150_000);
  const base = process.env.R17_BASE_URL ?? 'http://127.0.0.1:8197';
  const shots = process.env.R17_SHOT_DIR ?? 'artifacts/r17';
  fs.mkdirSync(shots, { recursive: true });

  const dj = await browser.newContext();
  const holder = await browser.newContext();
  const pageDj = await dj.newPage();
  const pageHolder = await holder.newPage();
  const enter = async (page: import('@playwright/test').Page) => {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const gate = page.getByRole('button', { name: /Studio betreten/ });
    if (await gate.isVisible().catch(() => false)) await gate.click();
    await expect(page.locator('#rack-mixer')).toBeVisible({ timeout: 60000 });
  };
  await enter(pageDj);
  await enter(pageHolder);

  // The first joined member holds mixerMONK and is therefore the DJ.
  await expect.poll(async () => pageDj.locator('#rack-mixer').getAttribute('data-plugin-owner'), { timeout: 20000 }).toBe('me');

  // The second member takes eqMONK so there is a foreign holder to ask.
  await pageHolder.getByRole('button', { name: 'eqMONK An' }).click();
  await expect.poll(async () => pageHolder.locator('#rack-eq').getAttribute('data-plugin-owner'), { timeout: 20000 }).toBe('me');
  await pageDj.screenshot({ path: `${shots}/01-dj-before.png`, fullPage: false });

  // DJ asks, the holder sees the five-second modal.
  await pageDj.locator('[data-takeover-request="eq"]').click();
  await expect(pageHolder.locator('[data-takeover-modal="eq"]')).toBeVisible({ timeout: 8000 });
  const countdown = await pageHolder.locator('[data-takeover-countdown]').innerText();
  await pageHolder.screenshot({ path: `${shots}/02-holder-modal-countdown.png`, fullPage: false });
  await pageDj.screenshot({ path: `${shots}/03-dj-waiting.png`, fullPage: false });

  // No answer -> the server transfers after the deadline.
  await expect.poll(async () => pageDj.locator('#rack-eq').getAttribute('data-plugin-owner'), { timeout: 12000 }).toBe('me');
  await pageDj.screenshot({ path: `${shots}/04-dj-after-timeout.png`, fullPage: false });

  const evidence = { countdownSeen: countdown, djOwnsEqAfterTimeout: true, screenshots: fs.readdirSync(shots).sort() };
  fs.writeFileSync(`${shots}/evidence.json`, JSON.stringify(evidence, null, 2));
  await dj.close();
  await holder.close();
});
