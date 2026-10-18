const { chromium } = require('playwright');
const fs = require('fs');
const token = (fs.readFileSync('/mnt/wd-elements/Medien/Projekte/audioMONASTRY/.env', 'utf8')
  .split('\n').find((l) => l.startsWith('STUDIO_ACCESS_TOKEN=')) || '').split('=').slice(1).join('=').trim();

(async () => {
  const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 },
    storageState: { cookies: [{ name: 'studio', value: token, domain: 'anunnakitools.de', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }], origins: [] } });
  const p = await ctx.newPage();
  // AudioContext instrumentieren
  await p.addInitScript(() => {
    window.__ac = [];
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const Wrapped = function (...args) {
      const c = new AC(...args);
      window.__ac.push({ state: c.state, sr: c.sampleRate, t: Date.now() });
      const resume = c.resume.bind(c);
      c.resume = function () { window.__ac.push({ resumed: true }); return resume(); };
      return c;
    };
    Wrapped.prototype = AC.prototype;
    window.AudioContext = Wrapped;
    window.webkitAudioContext = Wrapped;
  });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  await p.goto('https://anunnakitools.de/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(2500);
  const e = p.getByRole('button', { name: /Studio betreten/i }).first();
  if (await e.count()) { await e.click(); await p.waitForTimeout(2500); }

  const info = await p.evaluate(() => {
    const rack = document.querySelector('[data-rack="mixer"], .am-rack, [class*="am-rack"]');
    if (!rack) return { found: false };
    const r = rack.getBoundingClientRect();
    const children = [...rack.querySelectorAll('*')];
    const faders = children.filter((el) => el.matches('input[type=range]'));
    const buttons = children.filter((el) => el.matches('button'));
    const labels = [...new Set([...buttons.map((b) => b.getAttribute('aria-label') || b.title || b.textContent || ''), ...faders.map((f) => f.getAttribute('aria-label') || f.title || f.textContent || '')]).filter((s) => s && s.length > 0)];
    return {
      found: true,
      rackRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      faderCount: faders.length,
      faderVisible: faders.filter((f) => { const rr = f.getBoundingClientRect(); return rr.width > 0 && rr.height > 0; }).length,
      buttonCount: buttons.length,
      labelSample: labels.slice(0, 10),
      childrenCount: children.length,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await b.close();
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
