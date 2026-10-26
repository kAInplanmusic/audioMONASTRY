/**
 * Produktions-Smoke gegen die Hetzner-Flotte (2026-10-25).
 * Löst anunnakitools.de per --host-resolver-rules auf die Origin-IP auf
 * (Cloudflare-Apex zeigt auf alte Origin; Zertifikat wird ignoriert).
 */
const { chromium } = require('playwright');
const fs = require('fs');

const ORIGIN_IP = process.env.ORIGIN_IP || '88.99.189.131';
const HOST = 'anunnakitools.de';

function token() {
  const t = (process.env.STUDIO_ACCESS_TOKEN || '').trim();
  if (t) return t;
  try {
    const line = fs.readFileSync('.env.deploy', 'utf8').split('\n').find((l) => l.startsWith('STUDIO_ACCESS_TOKEN='));
    return (line?.slice('STUDIO_ACCESS_TOKEN='.length) || '').trim().replace(/^["']|["']$/g, '');
  } catch { return ''; }
}

(async () => {
  const browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${HOST} ${ORIGIN_IP}`],
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    storageState: { cookies: [{ name: 'studio', value: token(), domain: HOST, path: '/', expires: -1 }], origins: [] },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

  const out = { steps: [] };
  try {
    const r = await page.goto(`https://${HOST}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    out.httpStatus = r ? r.status() : null;
    out.title = await page.title();
    out.steps.push('startseite geladen');

    // Studio betreten
    await page.getByRole('button', { name: /studio betreten/i }).click();
    await page.waitForSelector('#studio-main', { timeout: 45000 });
    out.steps.push('studio betreten');

    // Kopf-Navigation (16 Icons)
    out.headerIcons = await page.locator('nav.am-ics button.am-ic').count();

    // Mixer ist beim ersten Nutzer automatisch ON/Halter – Panel ist offen.
    // Signalweg-Leiste im Mixer (nur sichtbar, wenn der Mixer offen ist)
    await page.waitForSelector('.am-mxchain', { state: 'visible', timeout: 20000 });
    out.chainStages = await page.locator('.am-mxchain button').count();
    out.chainHasMainOut = (await page.locator('.am-mxchain').innerText()).includes('Main Out');
    out.steps.push('signalweg-leiste');

    // Neues Rack: effectMONK holen + aktivieren → EffectRack muss rendern
    const effectRack = page.locator('#rack-effect');
    await effectRack.locator('.am-pw').click();
    await effectRack.locator('.am-pw').click();
    await page.waitForSelector('[data-testid=effect-rack]', { timeout: 20000 });
    out.effectRack = true;
    out.effectKnobs = await page.locator('[data-testid=effect-rack] .am-kn').count();
    out.steps.push('effectMONK/EffectRack');

    // eqMONK
    const eqRack = page.locator('#rack-eq');
    await eqRack.locator('.am-pw').click();
    await eqRack.locator('.am-pw').click();
    await page.waitForSelector('[data-testid=eq-rack]', { timeout: 20000 });
    out.eqRack = true;
    out.eqBands = await page.locator('[data-testid=eq-rack] .am-collapsible').count();
    out.steps.push('eqMONK/EqRack');

    // dsp + spatial
    for (const id of ['dsp', 'spatial']) {
      const rack = page.locator(`#rack-${id}`);
      await rack.locator('.am-pw').click();
      await rack.locator('.am-pw').click();
      await page.waitForSelector(`[data-testid=${id}-rack]`, { timeout: 20000 });
      out[`${id}Rack`] = true;
    }
    out.steps.push('dspMONK+SpatialRack');
    // XyPad liegt im Tab "Objekte"
    await page.locator('[data-testid=spatial-rack] [role=tab]', { hasText: 'Objekte' }).click();
    await page.waitForSelector('[data-testid=spatial-rack] .am-xypad', { timeout: 10000 });
    out.xyPad = await page.locator('[data-testid=spatial-rack] .am-xypad').count();

    // Mastergraph-Anzeigen
    const mpi = await page.locator('.am-mpi').first().innerText();
    out.hasLufsM = mpi.includes('LUFS M');
    out.hasTruePeak = mpi.includes('TRUE PEAK');
    out.steps.push('mastergraph-readout');

    await page.screenshot({ path: 'reports/prod-smoke-2026-10-25.png', fullPage: false });
    out.screenshot = 'reports/prod-smoke-2026-10-25.png';
  } catch (e) {
    out.error = e.message;
    try { await page.screenshot({ path: 'reports/prod-smoke-2026-10-25-fail.png' }); } catch { /* noop */ }
  } finally {
    out.pageErrors = errors.slice(0, 8);
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 2));
  const ok = !out.error && out.effectRack && out.eqRack && out.dspRack && out.spatialRack && out.chainHasMainOut;
  process.exit(ok ? 0 : 1);
})();
