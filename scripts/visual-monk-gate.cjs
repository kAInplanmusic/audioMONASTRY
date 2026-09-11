// VisualMONK-Gate: App starten, Overlay öffnen, Canvas prüfen (echter Browser).
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  const badResponses = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(3000);

  // Studio betreten (Startgate)
  const enter = page.locator('button', { hasText: /STUDIO BETRETEN|audioMONASTRY starten/i }).first();
  if (await enter.count()) { await enter.click({ timeout: 15000 }).catch(() => {}); }
  await page.waitForTimeout(4000);

  const visualBtn = page.locator('[aria-label="VisualMONK Liveshow oeffnen"]').first();
  const hasBtn = await visualBtn.count();
  if (hasBtn) await visualBtn.click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="VisualMONK Liveshow"]');
    const canvas = dialog ? dialog.querySelector('canvas') : null;
    let nonUniform = false;
    let uniqueColors = 0;
    if (canvas instanceof HTMLCanvasElement && canvas.width > 0) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const sw = Math.min(300, canvas.width), sh = Math.min(220, canvas.height);
        const sx = Math.max(0, Math.floor(canvas.width / 2 - sw / 2));
        const sy = Math.max(0, Math.floor(canvas.height / 2 - sh / 2));
        const data = ctx.getImageData(sx, sy, sw, sh).data;
        const seen = new Set();
        let min = 255, max = 0;
        for (let i = 0; i < data.length; i += 4) {
          const v = data[i] + data[i + 1] + data[i + 2];
          min = Math.min(min, v); max = Math.max(max, v);
          if (seen.size < 5000) seen.add((data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4));
        }
        nonUniform = max - min > 30;
        uniqueColors = seen.size;
      }
    }
    return {
      dialogFound: !!dialog,
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      streamButton: !!Array.from(document.querySelectorAll('button')).find((b) => /GHOSTUSER 6/.test(b.textContent || '')),
      presetButtons: dialog ? dialog.querySelectorAll('button').length : 0,
      nonUniform,
      uniqueColors,
    };
  });

  console.log(JSON.stringify({ hasVisualButton: !!hasBtn, ...info, badResponses }, null, 2));
  console.log('errors:', errs.slice(0, 6));
  await browser.close();
  const ok = hasBtn && info.dialogFound && info.canvas && info.nonUniform;
  process.exit(ok ? 0 : 4);
})().catch((e) => { console.error('VISUAL-GATE-ABBRUCH:', e.message); process.exit(3); });
