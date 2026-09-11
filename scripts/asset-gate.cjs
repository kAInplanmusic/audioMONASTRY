// Asset-Gate: laedt die Studio-Startseite und meldet fehlende Assets (4xx/5xx).
// Schuetzt vor gebrochenen Bildpfaden nach public/-Umsortierungen.
const { chromium } = require('playwright');

const BASE = process.env.GATE_URL || 'http://localhost:8080';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(8000);
  const images = await page.evaluate(() =>
    Array.from(document.images).map((i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 })),
  );
  const brokenImgs = images.filter((i) => !i.ok);
  console.log(JSON.stringify({ badResponses: bad, brokenImages: brokenImgs }, null, 2));
  await browser.close();
  process.exit(bad.length === 0 && brokenImgs.length === 0 ? 0 : 4);
})().catch((e) => { console.error('ASSET-GATE-ABBRUCH:', e.message); process.exit(3); });
