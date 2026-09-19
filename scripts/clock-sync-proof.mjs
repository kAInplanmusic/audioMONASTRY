/**
 * Live-Messung: Clock-Sync zwischen zwei Clients (Serveruhr)
 * =====================================================================
 * Beantwortet die offene Zeile "2-Browser-Clock-Offset" aus der Live-Checkliste.
 *
 * Hintergrund (Befund 2026-09-19): die NTP-artige Sync-Kette war vorhanden, aber
 * niemand sendete je einen Ping - `syncCount` blieb 0. Jetzt pingt jeder Client
 * alle 15 s; dieses Skript liest in ZWEI Browsern die Clock-Diagnose aus der
 * DSP-Konsole (RTT, Drift, Messungen) und vergleicht die Schaetzung der Serveruhr
 * beider Clients. Sehen beide dieselbe Serverzeit, ist die gemeinsame Zeitbasis
 * belegt - unabhaengig davon, wie die lokalen AudioContext-Uhren laufen.
 *
 * Aufruf: E2E_BASE_URL=http://localhost:8080 node scripts/clock-sync-proof.mjs
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = (process.env.E2E_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const token = (() => {
  const fromEnv = (process.env.STUDIO_ACCESS_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').find((l) => l.startsWith('STUDIO_ACCESS_TOKEN='));
  return (line?.slice('STUDIO_ACCESS_TOKEN='.length) ?? '').trim();
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Liest die Clock-Anzeige einer Seite (DSP-Konsole). */
const readClock = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-clock-values]');
    if (!el) return null;
    const text = (needle) => {
      const row = Array.from(el.querySelectorAll('div')).find((d) => d.textContent?.includes(needle));
      const spans = row ? Array.from(row.querySelectorAll('span')) : [];
      return spans.length >= 2 ? String(spans[spans.length - 1].textContent ?? '') : '';
    };
    const offset = Number(el.getAttribute('data-clock-offset-ms'));
    return {
      messungen: Number(el.getAttribute('data-clock-values') ?? 0),
      rtt: text('CLOCK RTT'),
      drift: text('CLOCK DRIFT'),
      offsetMs: Number.isFinite(offset) ? offset : null,
      // Schaetzung der Serverzeit zum Messzeitpunkt (Serverzeit-Epoche).
      serverEstimate: Number.isFinite(offset) ? performance.now() + offset : null,
    };
  });

const openStudioWithDsp = async (ctx, label) => {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${label}] pageerror:`, e.message.slice(0, 100)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const start = page.getByLabel('audioMONASTRY starten');
  if (await start.count()) await start.first().click();
  await page.locator('button[data-plugin-id="dsp"]').first().click({ timeout: 20_000 }).catch(() => {});
  await page.locator('[data-clock-values]').first().waitFor({ timeout: 20_000 }).catch(() => {});
  return page;
};

const main = async () => {
  console.log(`Ziel: ${BASE} · Instanz: ${JSON.stringify(await (await fetch(`${BASE}/api/health`)).json())}`);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  const makeCtx = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (token) await ctx.addCookies([{ name: 'studio', value: token, url: BASE }]);
    return ctx;
  };

  const [pageA, pageB] = await Promise.all([
    makeCtx().then((c) => openStudioWithDsp(c, 'A')),
    makeCtx().then((c) => openStudioWithDsp(c, 'B')),
  ]);

  // Auf mindestens zwei Messungen je Client warten (die erste setzt nur den Offset).
  let a = null;
  let b = null;
  for (let i = 0; i < 40; i += 1) {
    [a, b] = await Promise.all([readClock(pageA), readClock(pageB)]);
    if ((a?.messungen ?? 0) >= 2 && (b?.messungen ?? 0) >= 2) break;
    await sleep(1_500);
  }

  // Beide Schaetzungen moeglichst gleichzeitig lesen, dann vergleichen.
  const [snapA, snapB] = await Promise.all([readClock(pageA), readClock(pageB)]);
  const diffMs = snapA?.serverEstimate != null && snapB?.serverEstimate != null
    ? Math.abs(snapA.serverEstimate - snapB.serverEstimate)
    : null;

  await browser.close();

  console.log('\nClient A:', JSON.stringify(snapA));
  console.log('Client B:', JSON.stringify(snapB));
  console.log('\nErgebnis:');
  console.log(`  Messungen je Client:        A=${snapA?.messungen ?? 0} · B=${snapB?.messungen ?? 0}`);
  console.log(`  Umlaufzeit (RTT):           A=${snapA?.rtt || '-'} · B=${snapB?.rtt || '-'}`);
  console.log(`  Drift seit letzter Messung: A=${snapA?.drift || '-'} · B=${snapB?.drift || '-'}`);
  console.log(`  Abweichung der Serveruhr-Schaetzung zwischen A und B: ${diffMs == null ? 'keine Messung' : `${diffMs.toFixed(1)} ms`}`);

  const synced = (snapA?.messungen ?? 0) >= 2 && (snapB?.messungen ?? 0) >= 2;
  const agreed = diffMs != null && diffMs < 250; // lokal sind wenige ms zu erwarten
  console.log(`  Beide Clients auf die Serveruhr eingemessen: ${synced ? 'JA' : 'NEIN'}`);
  console.log(`  Beide sehen dieselbe Serverzeit (< 250 ms):  ${agreed ? 'JA' : 'NEIN'}`);
  process.exit(synced && agreed ? 0 : 1);
};

main().catch((e) => {
  console.error('Messung fehlgeschlagen:', e.message);
  process.exit(1);
});
