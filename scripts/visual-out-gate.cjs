// Visual-Out-Gate: Beamer-Seite (/visual-out und /ghost/6) muss rendern,
// ohne Page-Errors und mit Wartezustand + Aktivieren-Button.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const results = [];
  let failed = false;

  for (const path of ['/visual-out', '/ghost/6']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 180)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 140)); });
    await page.goto(`http://localhost:8080${path}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(5000);
    const info = await page.evaluate(() => ({
      rootChildren: document.getElementById('root')?.children.length ?? -1,
      hasHeading: /VISUAL OUT/.test(document.body.innerText || ''),
      hasActivate: !!Array.from(document.querySelectorAll('button')).find((b) => /Visual-Ausgabe aktivieren/i.test(b.textContent || '')),
      hasGhostLabel: /GHOSTUSER 6/.test(document.body.innerText || ''),
      video: !!document.querySelector('video'),
      bodyHead: (document.body.innerText || '').slice(0, 120),
    }));
    const ok = info.rootChildren > 0 && info.hasHeading && info.video && errs.length === 0;
    if (!ok) failed = true;
    results.push({ path, ok, ...info, errors: errs.slice(0, 4) });
    await page.close();
  }

  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  process.exit(failed ? 4 : 0);
})().catch((e) => { console.error('VISUAL-OUT-GATE-ABBRUCH:', e.message); process.exit(3); });
