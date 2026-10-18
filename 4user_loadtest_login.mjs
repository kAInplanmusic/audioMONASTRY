#!/usr/bin/env node
/**
 * 4-User Parallel Load Test mit echtem Login
 * Loggt sich über Portal /api/login ein, holt Cookies, startet 4 Playwright-Browser parallel
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PORTAL_URL = 'https://anunnakitools.de';
const BASE_URL = PORTAL_URL;

async function loginAndGetCookies() {
  console.log('[Login] Logging in via API...');
  
  // Use fetch to login via API
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'change-me';
  
  const response = await fetch('https://anunnakitools.de/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: adminUser, pass: process.env.ADMIN_PASSWORD }),
  });
  
  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  if (!data.ok) {
    throw new Error('Login failed: ' + JSON.stringify(data));
  }
  
  // Extract cookies from response headers
  const cookieHeader = response.headers.get('set-cookie');
  const cookies = [];
  
  if (cookieHeader) {
    // Parse cookies from set-cookie header
    const cookieParts = cookieHeader.split(',');
    for (const part of cookieParts) {
      const [nameValue, ...attrs] = part.split(';').map(s => s.trim());
      const [name, value] = nameValue.split('=');
      if (name && value) {
        cookies.push({
          name,
          value,
          domain: 'anunnakitools.de',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        });
      }
    }
  }
  
  console.log('[Login] Cookies obtained:', cookies.map(c => c.name).join(', '));
  return cookies;
}

async function runUserSimulation(userId, cookies, userConfig) {
  console.log(`[User ${userId}] Starting simulation...`);
  
  const browser = await chromium.launch({ 
    headless: true, 
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] 
  });
  
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    permissions: ['microphone', 'midi'],
    storageState: {
      cookies: cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite
      })),
      origins: [],
    },
  });
  
  const page = await context.newPage();
  const errors = [];
  const networkErrors = [];
  const consoleLogs = [];
  
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleLogs.push({ type: msg.type(), text: msg.text().slice(0, 500) });
    }
  });
  page.on('pageerror', err => {
    errors.push({ type: 'pageerror', message: err.message.slice(0, 500) });
  });
  page.on('requestfailed', req => {
    networkErrors.push({ url: req.url().slice(0, 200), error: req.failure()?.errorText });
  });
  page.on('response', resp => {
    if (resp.status() >= 400) {
      networkErrors.push({ url: resp.url().slice(0, 200), status: resp.status() });
    }
  });
  
  try {
    console.log(`[User ${userId}] Navigating to ${BASE_URL}...`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    // Check if already in studio or need to enter
    const title = await page.title();
    console.log(`[User ${userId}] Page title: ${title}`);
    
    // Enter studio if button exists
    const enterBtn = page.getByRole('button', { name: /Studio betreten|audioMONASTRY starten/i }).first();
    if (await enterBtn.count()) {
      console.log(`[User ${userId}] Clicking Studio enter button...`);
      await enterBtn.click({ force: true });
      await page.waitForTimeout(3000);
    }
    
    // User-specific actions
    await userConfig.actions(page, userId);
    
    // Wait 30 seconds active
    console.log(`[User ${userId}] Waiting 30s active...`);
    await page.waitForTimeout(30000);
    
    // Final audio state check
    const audioState = await page.evaluate(() => {
      const ctxs = [];
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctxs.push({ hasAudioContext: !!AC });
      } catch {}
      return {
        ctxs,
        audioEls: document.querySelectorAll('audio').length,
        buttonsEnabled: document.querySelectorAll('button:not([disabled])').length,
        buttonsDisabled: document.querySelectorAll('button[disabled]').length,
      };
    });
    
    await page.screenshot({ path: `/tmp/user${userId}_final.png`, fullPage: true });
    
    return {
      userId,
      success: true,
      title,
      audioState,
      errors: errors.slice(-10),
      networkErrors: networkErrors.slice(-20),
      consoleLogs: consoleLogs.slice(-10),
    };
  } catch (err) {
    return {
      userId,
      success: false,
      error: err.message,
      errors: errors.slice(-10),
      networkErrors: networkErrors.slice(-20),
      consoleLogs: consoleLogs.slice(-10),
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('=== 4-User Parallel Load Test with Login ===');
  
  // Check required env vars
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
    console.error('ERROR: ADMIN_USER and ADMIN_PASSWORD must be set');
    process.exit(1);
  }
  
  // Step 1: Login and get cookies
  const cookies = await loginAndGetCookies();
  
  // Save cookies for reuse
  fs.writeFileSync('/tmp/portal_cookies.json', JSON.stringify(cookies, null, 2));
  console.log('[Main] Cookies saved to /tmp/portal_cookies.json');
  
  // Step 2: Define user configurations
  const userConfigs = [
    {
      id: 1,
      name: 'mixerMONK',
      actions: async (page, userId) => {
        console.log('[User 1] mixerMONK actions...');
        // Click mixer button
        const mixerBtn = page.locator('text=mixerMONK').first();
        if (await mixerBtn.count()) {
          await mixerBtn.scrollIntoViewIfNeeded();
          await mixerBtn.click({ force: true });
          await page.waitForTimeout(2000);
        }
        // Move some faders (only enabled ones)
        const faders = page.locator('input[type=range]:not([disabled])');
        const count = await faders.count();
        console.log(`[User 1] Found ${count} enabled faders`);
        for (let i = 0; i < Math.min(3, count); i++) {
          const fader = faders.nth(i);
          await fader.fill(String(Math.floor(Math.random() * 100)));
          await page.waitForTimeout(200);
        }
        // Click some pads
        const pads = page.locator('button, [role=button]').filter({ hasText: /pad|drum|kick|snare/i }).first();
        if (await pads.count()) {
          await pads.click({ force: true });
          await page.waitForTimeout(500);
        }
      }
    },
    {
      id: 2,
      name: 'Instruments',
      actions: async (page, userId) => {
        console.log('[User 2] Instruments actions...');
        // Click instru button
        const instruBtn = page.locator('[data-plugin-id="instru"], button:has-text("instru")').first();
        if (await instruBtn.count()) {
          await instruBtn.click({ force: true });
          await page.waitForTimeout(2000);
        }
        // Try to turn on instruMONK
        const onBtn = page.locator('button:has-text("ON"), button[title*="STBY"]').first();
        if (await onBtn.count()) {
          await onBtn.click({ force: true });
          await page.waitForTimeout(1000);
        }
        // Check selects for MIDI
        const selects = page.locator('select');
        const selectCount = await selects.count();
        console.log(`[User 2] Found ${selectCount} select elements`);
        for (let i = 0; i < Math.min(3, selectCount); i++) {
          const sel = selects.nth(i);
          const options = await sel.locator('option').all();
          console.log(`[User 2] Select ${i}: ${options.length} options`);
        }
      }
    },
    {
      id: 3,
      name: 'Capture/Transport',
      actions: async (page, userId) => {
        console.log('[User 3] Capture/Transport actions...');
        // Try capture button
        const captureBtn = page.locator('button:has-text("Capture"), button[aria-label*="Capture"]').first();
        if (await captureBtn.count()) {
          const isDisabled = await captureBtn.isDisabled();
          console.log(`[User 3] Capture button disabled: ${isDisabled}`);
          if (!isDisabled) {
            await captureBtn.click({ force: true });
            await page.waitForTimeout(2000);
          }
        }
        // Try record button
        const recordBtn = page.locator('button:has-text("Record"), button[aria-label*="Record"]').first();
        if (await recordBtn.count()) {
          await recordBtn.click({ force: true });
          await page.waitForTimeout(2000);
        }
        // Try play/stop
        const playBtn = page.locator('button:has-text("Play"), button:has-text("▶")').first();
        if (await playBtn.count()) {
          const isDisabled = await playBtn.isDisabled();
          console.log(`[User 3] Play button disabled: ${isDisabled}`);
        }
      }
    },
    {
      id: 4,
      name: 'Plugin Racks',
      actions: async (page, userId) => {
        console.log('[User 4] Plugin Rack actions...');
        // Try to find and click rack buttons
        const rackButtons = page.locator('button[title*="MONK"], button[aria-label*="MONK"]').first();
        if (await rackButtons.count()) {
          const count = await rackButtons.count();
          console.log(`[User 4] Found ${count} MONK rack buttons`);
        }
        // Try to find sliders/knobs (only enabled ones - exclude disabled and aria-disabled)
        const sliders = page.locator('input[type=range]:not([disabled]), [role=slider]:not([disabled]):not([aria-disabled="true"])');
        const sliderCount = await sliders.count();
        console.log(`[User 4] Found ${sliderCount} enabled sliders/knobs`);
        // Try to move some
        for (let i = 0; i < Math.min(5, sliderCount); i++) {
          await sliders.nth(i).fill(String(Math.floor(Math.random() * 100)));
          await page.waitForTimeout(100);
        }
      }
    },
  ];
  
  // Step 3: Run all users in parallel
  console.log('\n=== Starting 4 parallel user simulations ===\n');
  
  const results = await Promise.all(
    userConfigs.map(config => runUserSimulation(config.id, cookies, config))
  );
  
  // Step 4: Report
  console.log('\n=== RESULTS ===');
  for (const r of results) {
    console.log(`\n--- User ${r.userId} (${userConfigs[r.userId-1].name}) ---`);
    console.log(`Success: ${r.success}`);
    if (!r.success) {
      console.log(`Error: ${r.error}`);
    } else {
      console.log(`Title: ${r.title}`);
      console.log(`AudioState: ${JSON.stringify(r.audioState)}`);
      console.log(`Errors: ${r.errors.length}`);
      console.log(`NetworkErrors: ${r.networkErrors.length}`);
      console.log(`ConsoleLogs: ${r.consoleLogs.length}`);
      if (r.errors.length) console.log('Errors:', r.errors);
      if (r.networkErrors.length) console.log('NetworkErrors:', r.networkErrors.slice(0, 5));
    }
  }
  
  // Save full report
  const report = {
    timestamp: new Date().toISOString(),
    cookiesUsed: cookies.length,
    users: results,
  };
  fs.writeFileSync('/tmp/4user_loadtest_report.json', JSON.stringify(report, null, 2));
  console.log('\n[Main] Full report saved to /tmp/4user_loadtest_report.json');
}

main().catch(err => {
  console.error('[Main] Fatal error:', err);
  process.exit(1);
});