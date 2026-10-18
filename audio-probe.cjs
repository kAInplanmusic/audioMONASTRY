const { chromium } = require('playwright');
const fs = require('fs');
const token = (fs.readFileSync('/mnt/wd-elements/Medien/Projekte/audioMONASTRY/.env', 'utf8')
  .split('\n').find((l) => l.startsWith('STUDIO_ACCESS_TOKEN=')) || '').split('=').slice(1).join('=').trim();

(async () => {
  const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['microphone', 'midi'],
    storageState: { cookies: [{ name: 'studio', value: token, domain: 'anunnakitools.de', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }], origins: [] } });
  const p = await ctx.newPage();
  // AudioContext instrumentieren, BEVOR App-Code laeuft
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

  const faders = await p.evaluate(() => {
    const s = [...document.querySelectorAll('input[type=range]')];
    return { total: s.length, enabled: s.filter((x) => !x.disabled).length,
      visible: s.filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length };
  });

  // Pad / Trommel / Taste suchen und klicken (Ton-Erzeugung)
  const candidates = [/kick/i, /snare/i, /pad/i, /trommel/i, /drum/i, /note/i, /key/i];
  const clicked = [];
  for (const re of candidates) {
    const el = p.locator(`button, [role=button], [data-pad]`).filter({ hasText: re }).first();
    if (await el.count()) {
      try { await el.click({ force: true, timeout: 2500 }); clicked.push(String(re)); await p.waitForTimeout(600); } catch {}
      if (clicked.length >= 2) break;
    }
  }
  await p.waitForTimeout(1500);
  const audio = await p.evaluate(() => {
    const list = window.__ac || [];
    return { creations: list.length, detail: list.slice(0, 6) };
  });
  const meters = await p.evaluate(() => document.querySelectorAll('[class*="meter" i], [data-meter]').length);
  console.log(JSON.stringify({ faders, clicked, audio, meterEls: meters, errors: errs.slice(-5) }, null, 2));
  await b.close();
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
