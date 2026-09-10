// Diagnose: welche Bedienelemente bietet die Startansicht wirklich?
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160));
  });

  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => !!(window.__audioMonastry && window.__audioMonastry.audioEngine), null, { timeout: 60_000 });
  await page.waitForTimeout(6000);

  const info = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'));
    return {
      title: document.title,
      rootChildren: document.getElementById('root')?.children.length ?? -1,
      bodyTextHead: (document.body.innerText || '').slice(0, 400),
      candidates: buttons.slice(0, 40).map((b) => ({
        tag: b.tagName.toLowerCase(),
        label: b.getAttribute('aria-label'),
        text: (b.innerText || '').trim().slice(0, 48),
      })),
    };
  });

  console.log(JSON.stringify(info, null, 2));
  console.log('errors:', errs.slice(0, 8));
  await browser.close();
})().catch((e) => {
  console.error('DIAG-ABBRUCH:', e.message);
  process.exit(3);
});
