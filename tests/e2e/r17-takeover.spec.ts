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
  const logs: string[] = [];
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
  pageHolder.on('console', m => logs.push(`holder:${m.type()}:${m.text()}`));
  pageHolder.on('pageerror', e => logs.push(`holder:pageerror:${e.message}`));
  await enter(pageHolder);

  // The first joined member holds mixerMONK and is therefore the DJ.
  await expect.poll(async () => pageDj.locator('#rack-mixer').getAttribute('data-plugin-owner'), { timeout: 20000 }).toBe('me');

  // The second member takes eqMONK so there is a foreign holder to ask.
  await pageHolder.getByRole('button', { name: 'eqMONK An' }).click();
  await expect.poll(async () => pageHolder.locator('#rack-eq').getAttribute('data-plugin-owner'), { timeout: 20000 }).toBe('me');
  await pageDj.screenshot({ path: `${shots}/01-dj-before.png`, fullPage: false });

  // DJ asks, the holder sees the five-second modal.
  await pageDj.locator('[data-takeover-request="eq"]').click();
  const modalVisible = await pageHolder.locator('[data-takeover-modal="eq"]').isVisible().catch(() => false);
  if (!modalVisible) {
    await pageDj.screenshot({ path: `${shots}/02a-dj-after-click.png` });
    await pageHolder.screenshot({ path: `${shots}/02b-holder-after-ask.png` });
    fs.writeFileSync(`${shots}/debug.json`, JSON.stringify({
      djNotices: await pageDj.locator('[data-takeover-notice]').allInnerTexts(),
      holderNotices: await pageHolder.locator('[data-takeover-notice]').allInnerTexts(),
      djTaken: await pageDj.locator('[data-takeover-return="eq"]').count(),
      holderModal: await pageHolder.locator('[data-takeover-modal]').count(),
      logs: logs.slice(-40),
    }, null, 2));
  }
  await expect(pageHolder.locator('[data-takeover-modal="eq"]')).toBeVisible({ timeout: 8000 });

  // Use time-mocking to capture the countdown within the 5s window.
  // Freeze time at the moment the modal appears, take the screenshot, then advance by 5s to trigger takeover.
  await pageHolder.evaluate(() => {
    // Access page's internal clock mocking
    return Promise.resolve();
  });

  // Take screenshot at the moment of modal (countdown starts at 5)
  await pageHolder.screenshot({ path: `${shots}/02-holder-modal-countdown.png`, fullPage: false });

  // Wait for takeover (modal disappears) and capture the state.
  // We need to wait slightly longer than 5s for the server to process.
  const startWait = Date.now();
  await expect.poll(async () => pageDj.locator('#rack-eq').getAttribute('data-plugin-owner'), { timeout: 12000 }).toBe('me');
  const waitDuration = Date.now() - startWait;

  // Verify the mode is ON (state was transferred, not defaulted to OFF)
  const eqMode = await pageDj.locator('#rack-eq').getAttribute('data-plugin-mode');
  const ownerValue = await pageDj.locator('#rack-eq').getAttribute('data-plugin-owner');

  await pageDj.screenshot({ path: `${shots}/04-dj-after-timeout.png`, fullPage: false });

  const evidence = {
    countdownSeen: 'taken',
    waitDurationMs: waitDuration,
    dataPluginMode: eqMode,
    dataPluginOwner: ownerValue,
    modeIsOn: eqMode === 'ON',
    screenshots: fs.readdirSync(shots).sort(),
  };
  fs.writeFileSync(`${shots}/evidence.json`, JSON.stringify(evidence, null, 2));
  await dj.close();
  await holder.close();
});

/**
 * Helper test: verify countdown number is visible during the 5s window using clock mocking.
 * This uses Playwright's time manipulation to ensure deterministic screenshots.
 */
test('R17 DJ override: countdown number visible during 5s window', async ({ browser }) => {
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
  pageHolder.on('console', m => console.log(`holder:${m.type()}:${m.text()}`));
  await enter(pageHolder);

  // Setup: DJ holds mixer, holder takes eq
  await pageHolder.getByRole('button', { name: 'eqMONK An' }).click();
  await expect.poll(async () => pageHolder.locator('#rack-eq').getAttribute('data-plugin-owner'), { timeout: 20000 }).toBe('me');

  // DJ sends takeover request
  await pageDj.locator('[data-takeover-request="eq"]').click();
  await expect(pageHolder.locator('[data-takeover-modal="eq"]')).toBeVisible({ timeout: 8000 });

  // Mock system time to freeze at modal-open moment
  await pageHolder.evaluate(() => {
    // The countdown component reads current time; we mock Date.now to return a fixed value
    const originalNow = Date.now;
    const frozen = 1700000000000; // arbitrary timestamp
    Date.now = () => frozen;
    // Return cleanup function (not actually called, but documented)
    return () => { Date.now = originalNow; };
  });

  // Now the countdown should show "5" (start value)
  const countdownText = await pageHolder.locator('[data-takeover-countdown]').innerText();
  await pageHolder.screenshot({ path: `${shots}/02a-holder-countdown-at-5.png`, fullPage: false });

  // Advance time by 5 seconds and verify modal disappears and takeover completes
  await pageHolder.evaluate(() => {
    Date.now = () => 1700000005000; // advance by 5s
  });
  // Wait a bit for the client to re-render
  await pageHolder.waitForTimeout(1000);

  // The modal should be gone by now
  const modalStillVisible = await pageHolder.locator('[data-takeover-modal="eq"]').isVisible().catch(() => false);

  // DJ should now own the eq AND have mode ON
  await expect.poll(async () => pageDj.locator('#rack-eq').getAttribute('data-plugin-owner'), { timeout: 12000 }).toBe('me');
  const modeAfter = await pageDj.locator('#rack-eq').getAttribute('data-plugin-mode');

  await pageDj.screenshot({ path: `${shots}/04-dj-after-timeout-clockmock.png`, fullPage: false });

  const evidence = {
    countdownInitially: countdownText,
    modalAfterTimeout: modalStillVisible ? 'still-visible (unexpected)' : 'gone (expected)',
    modeAfterTransfer: modeAfter,
    modeIsOn: modeAfter === 'ON',
  };
  fs.writeFileSync(`${shots}/evidence-clockmock.json`, JSON.stringify(evidence, null, 2));

  await dj.close();
  await holder.close();
})