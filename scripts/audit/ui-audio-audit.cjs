#!/usr/bin/env node
/**
 * UI-Bedienelement-Audit, Laufzeit (2026-10-26)
 * =============================================
 * Enumeriert JEDES sichtbare Bedienelement eines Racks direkt aus dem DOM,
 * taggt es eindeutig (`data-audit-id`) und prüft je Element:
 *   1. Funktionalität – bedienbar, keine Exception
 *   2. Verkabelung    – löst es einen Engine-Aufruf aus? (window.__amProbe.calls)
 *   3. MAIN-Einfluss  – ändert sich die Messung des MAIN-Signals? (window.__amProbe.measure)
 *
 * Verdikte: WIRED_MAIN · WIRED_NO_MAIN · MAIN_WITHOUT_ENGINE_CALL · NO_EFFECT · UI_ONLY · SKIPPED
 * `UI_ONLY` = bewusst reine Bedienoberfläche (Tab, Skin, Sprung, Dialog) – kein Audioanspruch.
 *
 * Aufruf: node scripts/audit/ui-audio-audit.cjs [--rack=mixer,effect] [--json=out.json] [--limit=N]
 * Voraussetzung: `npx vite --port 5199` UND `npx tsx server.ts` (Backend für Session/Locks).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HOST = process.env.AUDIT_HOST || 'localhost:5199';
const BASE = `http://${HOST}`;
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const RACKS = (arg('rack', 'mixer,effect,eq,dsp,spatial,master,record') || '').split(',').filter(Boolean);
const LIMIT = Number(arg('limit', '0')) || 0;
const OUT = arg('json', 'reports/ui-audio-audit.json');

/** Beschriftungen ohne Audioanspruch (reine Oberfläche). */
const UI_ONLY_LABEL = /^(CDJ|PADS|LIB|Weich|Hart|A|B|THRU|▾|▸|✕|Einklappen|Aufklappen|Schließen|OK|Abbrechen)$/i;

/**
 * Bedienelemente, die den Panel-Zustand selbst verändern. Werden zuletzt und
 * mit Wiederherstellung geprüft — klickt das Audit sie in der Mitte der Liste,
 * ist die Bedienfläche danach zu und alle folgenden Elemente sind unauffindbar
 * (genau das hat 116 Elemente pro Lauf gekostet).
 */
const PANEL_BREAKER = /(zusammenklappen|zuklappen|aufklappen|Modus (ON|OFF|STBY)|Modul (ON|OFF|STBY))/i;

function token() {
  const t = (process.env.STUDIO_ACCESS_TOKEN || '').trim();
  if (t) return t;
  // Lokaler Dev-Server prüft den Token aus .env, der deployte Knoten den aus
  // .env.deploy – die beiden unterscheiden sich (gemessen: 52 vs. 64 Zeichen).
  const local = /^(localhost|127\.0\.0\.1)/.test(HOST);
  for (const f of (local ? ['.env', '.env.deploy'] : ['.env.deploy', '.env'])) {
    try {
      const line = fs.readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith('STUDIO_ACCESS_TOKEN='));
      if (line) return line.slice('STUDIO_ACCESS_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
    } catch { /* weiter */ }
  }
  return '';
}

/** Im Browser: Elemente sammeln UND eindeutig taggen (stabiler Selektor). */
const ENUMERATE = (rootSel) => {
  const root = document.querySelector(rootSel);
  if (!root) return [];
  const SEL = 'button, input, select, textarea, [role="slider"], [role="gridcell"], [role="tab"]';
  const out = [];
  const seen = new Map();
  [...root.querySelectorAll(SEL)].forEach((el, i) => {
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return;
    const id = `a${i}`;
    el.setAttribute('data-audit-id', id);
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim().slice(0, 60) || `element-${i}`;
    const tag = el.tagName.toLowerCase();
    // Vorkommen gleicher Beschriftung unterscheiden (z. B. mehrere „M"-Taster).
    const key = `${tag}|${label}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    out.push({
      id,
      nth,
      tag,
      role: el.getAttribute('role') || '',
      label,
      cls: String(el.className || '').slice(0, 50),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      value: el.value ?? el.getAttribute('aria-valuenow') ?? null,
    });
  });
  return out;
};

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const hostName = HOST.split(':')[0];
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    storageState: { cookies: [{ name: 'studio', value: token(), domain: hostName, path: '/', expires: -1 }], origins: [] },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 140)}`); });

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByRole('button', { name: /studio betreten/i }).click();
  await page.waitForSelector('#studio-main', { timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__amProbe), null, { timeout: 30000 });
  // Zuteilung abwarten: der Server vergibt den Mixer an den ersten Nutzer.
  // Ohne diese Wartezeit liest das Audit einen Zustand mit disabled-Reglern
  // (owner=none) und überspringt die halbe Oberfläche.
  await page.waitForFunction(
    () => document.getElementById('rack-mixer')?.getAttribute('data-plugin-owner') === 'me',
    null,
    { timeout: 25000 },
  ).catch(() => {});
  const owner = await page.getAttribute('#rack-mixer', 'data-plugin-owner').catch(() => null);
  if (owner !== 'me') {
    console.error(`ABBRUCH: Mixer gehört "${owner ?? 'niemandem'}" statt diesem Browser.`);
    console.error('Meist läuft parallel eine zweite Session (anderes Audit/anderer Browser) –');
    console.error('der Server vergibt den Mixer nur einmal. Audit-Runs strikt nacheinander starten.');
    await browser.close();
    process.exit(2);
  }
  // Besitz allein öffnet die Bedienfläche nicht: sie hängt an mode=ON. Ohne
  // diese Wartezeit sind alle Regler im DOM, aber ohne Layout-Box (hidden).
  const panelOpen = await page.waitForFunction(() => {
    const sb = document.querySelector('#rack-mixer .am-sb');
    if (!sb || sb.hasAttribute('hidden')) return false;
    const knobs = [...sb.querySelectorAll('[role="slider"], button')];
    return knobs.some((el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
  }, null, { timeout: 25000 }).then(() => true).catch(() => false);
  if (!panelOpen) {
    console.error('ABBRUCH: mixerMONK-Bedienfläche ist nicht offen (mode != ON oder Panel eingeklappt).');
    await browser.close();
    process.exit(3);
  }
  await page.waitForTimeout(1200);

  const toneOk = await page.evaluate(async () => {
    try { return await window.__amProbe.tone(true, 440, 0.25); } catch { return false; }
  });
  // Erst neutralisieren, dann messen: alte Session-Stände (gedrehte Fader aus
  // früheren Läufen) können den Main auf 0 dB Restpegel bringen.
  await page.evaluate(() => window.__amProbe.resetBaseline());
  await page.waitForTimeout(500);
  const baseline = await page.evaluate(() => window.__amProbe.measure(400));
  const hasSignal = Boolean(baseline && baseline.rms > 1e-5);

  const results = [];

  for (const rack of RACKS) {
    const rackEl = page.locator(`#rack-${rack}`);
    if (!(await rackEl.count())) { results.push({ rack, audit: 'RACK_NOT_FOUND' }); continue; }

    // Modul öffnen (OFF → STBY → ON) und Panel aufklappen
    for (let k = 0; k < 2; k += 1) {
      const mode = await rackEl.getAttribute('data-plugin-mode');
      if (mode === 'OFF' || mode === 'STBY') await rackEl.locator('.am-pw').first().click({ timeout: 5000 }).catch(() => {});
    }
    const fold = rackEl.locator('.am-fold');
    if ((await fold.count()) && await fold.isEnabled().catch(() => false)) {
      if ((await fold.getAttribute('aria-expanded')) === 'false') await fold.click().catch(() => {});
    }
    await page.waitForTimeout(300);
    // geschlossene <details> öffnen, damit deren Regler sichtbar/messbar sind
    await page.evaluate((sel) => {
      document.querySelectorAll(`${sel} details:not([open])`).forEach((d) => d.setAttribute('open', ''));
    }, `#rack-${rack}`);
    await page.waitForTimeout(150);

    const items = await page.evaluate(ENUMERATE, `#rack-${rack}`);
    if (!items.length) { results.push({ rack, audit: 'RACK_NOT_OPEN' }); continue; }

    // Panel-Breaker (Zuklappen/Modus) zuletzt prüfen: sie schließen die Fläche.
    const ordered = [...items.filter((i) => !PANEL_BREAKER.test(i.label)), ...items.filter((i) => PANEL_BREAKER.test(i.label))];

    let done = 0;
    for (const it of ordered) {
      if (LIMIT && done >= LIMIT) break;
      // Panel-Zustand vor jedem Element sicherstellen: ein vorheriger Klick kann
      // es geschlossen haben (Modus-Button, Zuklappen, Modulwechsel).
      await page.evaluate((root) => {
        const sb = document.querySelector(`${root} .am-sb`);
        if (sb && sb.hasAttribute('hidden')) {
          const fold = document.querySelector(`${root} .am-fold`);
          if (fold && !fold.disabled) fold.click();
        }
      }, `#rack-${rack}`).catch(() => {});
      await page.waitForTimeout(80);
      // Neutralzustand vor jeder Messung: sonst misst man das Delta gegen den
      // Stand des vorherigen Reglers (und gegen alte Session-Stores).
      await page.evaluate(() => window.__amProbe.resetBaseline());
      await page.waitForTimeout(250);
      // Aufrufzähler NACH dem Reset lesen, damit die Reset-Aufrufe nicht als
      // „Engine-Kontakt des Bedienelements" gezählt werden.
      const beforeCalls = await page.evaluate(() => window.__amProbe.calls().total);
      const beforeM = await page.evaluate(() => window.__amProbe.measure(200));

      // WICHTIG: Koordinaten ERST JETZT bestimmen. resetBaseline() löst ein
      // Re-Render aus (pushAll über alle Kanäle); vorher gemessene Rects sind
      // danach verschoben und die Maus trifft ins Leere (gemessen 2026-10-26).
      const pt = await page.evaluate((spec) => {
        const SEL = 'button, input, select, textarea, [role="slider"], [role="gridcell"], [role="tab"]';
        const els = [...document.querySelectorAll(`${spec.root} ${SEL}`)];
        const labelOf = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent.trim().slice(0, 60) || '');
        const matches = els.filter((e) => labelOf(e) === spec.label && e.tagName.toLowerCase() === spec.tag);
        const el = matches[spec.nth] ?? matches[0];
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
      }, { root: `#rack-${rack}`, label: it.label, tag: it.tag, nth: it.nth ?? 0 });
      if (!pt) { results.push({ rack, ...it, audit: 'SKIPPED', reason: 'nicht (mehr) im DOM auffindbar' }); continue; }

      let action = 'click';
      try {
        const cx = pt.x;
        const cy = pt.y;
        if (it.tag === 'select') {
          // Öffnen/Auswahl: Wert per JS setzen + change-Event (native Auswahl-
          // Liste ist im Headless nicht bedienbar).
          const changed = await page.evaluate((spec) => {
            const SEL = 'select';
            const els = [...document.querySelectorAll(`${spec.root} ${SEL}`)];
            const labelOf = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || '');
            const el = els.filter((e) => labelOf(e) === spec.label)[spec.nth] ?? els.filter((e) => labelOf(e) === spec.label)[0];
            if (!el) return false;
            const opt = [...el.options].find((o) => o.value !== el.value);
            if (!opt) return false;
            el.value = opt.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }, { root: `#rack-${rack}`, label: it.label, nth: it.nth ?? 0 });
          if (!changed) { results.push({ rack, ...it, audit: 'SKIPPED', reason: 'keine alternative Option' }); continue; }
          action = 'select';
        } else if (it.tag === 'input' || it.tag === 'textarea') {
          await page.mouse.click(cx, cy);
          await page.keyboard.type('audit');
          action = 'type';
        } else if (it.role === 'slider' || /AmKnob|AmFader|AmHFader|AmBar/.test(it.cls)) {
          await page.mouse.move(cx, cy);
          await page.mouse.down();
          await page.mouse.move(cx, cy - Math.max(16, pt.h * 0.45), { steps: 8 });
          await page.mouse.up();
          action = 'drag';
        } else {
          await page.mouse.click(cx, cy);
          action = 'click';
        }
      } catch (e) {
        results.push({ rack, ...it, audit: 'SKIPPED', reason: `Interaktion: ${e.message.split('\n')[0].slice(0, 60)}` });
        continue;
      }

      await page.waitForTimeout(140);
      const afterM = await page.evaluate(() => window.__amProbe.measure(200));
      const called = await page.evaluate((n) => window.__amProbe.calls(n).calls.map((c) => c.m), beforeCalls);
      const unique = [...new Set(called)].filter((m) => !['readMeterValues', 'renderV2Block'].includes(m));

      const relRms = beforeM && afterM && beforeM.rms > 1e-9 ? Math.abs(afterM.rms - beforeM.rms) / beforeM.rms : 0;
      const dPeak = beforeM && afterM ? Math.abs(afterM.peak - beforeM.peak) : 0;
      const dLufs = beforeM && afterM ? Math.abs((afterM.lufsM || 0) - (beforeM.lufsM || 0)) : 0;
      const mainMoved = relRms > 0.02 || dPeak > 0.005 || dLufs > 0.2;

      let audit;
      if (unique.length && mainMoved) audit = 'WIRED_MAIN';
      else if (unique.length) audit = 'WIRED_NO_MAIN';
      else if (mainMoved) audit = 'MAIN_WITHOUT_ENGINE_CALL';
      else if (UI_ONLY_LABEL.test((it.label || '').trim())) audit = 'UI_ONLY';
      else audit = 'NO_EFFECT';

      results.push({
        rack, ...it, audit, action,
        engineCalls: unique,
        relRms: Number(relRms.toFixed(4)),
        dPeak: Number(dPeak.toFixed(4)),
        dLufs: Number(dLufs.toFixed(2)),
      });
      done += 1;
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const summary = results.reduce((a, r) => ((a[r.audit] = (a[r.audit] || 0) + 1), a), {});
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), host: HOST, toneOk, hasSignal,
    baseline, summary, consoleErrors: errors.slice(0, 20), controls: results,
  }, null, 2));

  console.log(`Testton: ${toneOk ? 'an' : 'FEHLT'} | MAIN-Signal: ${hasSignal ? `ja (rms ${baseline.rms.toFixed(5)})` : 'NEIN'}`);
  console.log('Ergebnis:', JSON.stringify(summary));
  const flagged = results.filter((r) => ['NO_EFFECT', 'MAIN_WITHOUT_ENGINE_CALL', 'WIRED_NO_MAIN', 'RACK_NOT_OPEN', 'RACK_NOT_FOUND'].includes(r.audit));
  if (flagged.length) {
    console.log(`\nAuffällig (${flagged.length}):`);
    for (const b of flagged.slice(0, 60)) {
      console.log(`  ${b.audit.padEnd(22)} ${(b.rack || '').padEnd(8)} ${(b.tag || '').padEnd(7)} ${JSON.stringify((b.label || '').slice(0, 42))} ${b.engineCalls ? 'calls=' + b.engineCalls.join(',') : b.reason || ''}`);
    }
  }
  console.log(`\nBericht: ${OUT}`);
  await browser.close();
})().catch((e) => { console.error('AUDIT-FEHLER:', e.message); process.exit(1); });
