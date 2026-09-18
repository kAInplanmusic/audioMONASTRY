/**
 * VISUAL-P1-010 · Messskript: welche Regionen der Studio-Ansicht ändern sich?
 * =====================================================================
 * Die visuellen Baselines waren flaky, weil die Seite live aktualisierte Bereiche
 * enthält. Statt blind zu maskieren, konvergiert dieses Skript empirisch gegen
 * eine stabile Aufnahme: es macht wiederholt zwei Aufnahmen im Abstand von 1,5 s
 * und vergleicht sie BYTE-GENAU. Erst wenn zwei Aufnahmen identisch sind, ist eine
 * Baseline reproduzierbar.
 *
 * Ausgegeben wird, welche Masken-Menge zum Ziel führt (Canvas, live-Werte,
 * Status-Badges) und wie lange es dauert - das ist die Grundlage für den Spec.
 *
 * Aufruf: node scripts/visual-stability-probe.mjs   (Server muss laufen)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

/**
 * Wo genau aendert sich das Bild? Zwei Aufnahmen werden per ffmpeg verglichen und
 * auf ein grobes Raster heruntergerechnet; die Zellen mit Abweichung werden als
 * prozentuale Bounding-Box ausgegeben. Damit wird GEZIELT maskiert statt geraten.
 */
const locateDiff = (a, b, size = 24) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vis-diff-'));
  try {
    const fa = path.join(dir, 'a.png');
    const fb = path.join(dir, 'b.png');
    writeFileSync(fa, a);
    writeFileSync(fb, b);
    const raw = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', fa, '-i', fb,
      '-filter_complex', `[0][1]blend=all_mode=difference,format=gray,scale=${size}:${size}:flags=area`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], { maxBuffer: 4 * 1024 * 1024 });
    let minX = size, minY = size, maxX = -1, maxY = -1;
    let worst = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const v = raw[y * size + x];
        if (v > 12) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          worst = Math.max(worst, v);
        }
      }
    }
    if (maxX < 0) return 'keine Zelle ueber der Schwelle';
    return `x ${Math.round((minX / size) * 100)}-${Math.round(((maxX + 1) / size) * 100)} %, `
      + `y ${Math.round((minY / size) * 100)}-${Math.round(((maxY + 1) / size) * 100)} % (max. Abweichung ${worst}/255)`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8080';
const TOKEN = process.env.STUDIO_TOKEN || '';

/** Masken-Kandidaten in der Reihenfolge, in der sie zugeschaltet werden. */
const CANDIDATES = [
  { name: 'canvas', selector: 'canvas' },
  { name: '[data-live-value]', selector: '[data-live-value]' },
  { name: '[role=status]', selector: '[role=status]' },
  { name: 'animate-pulse', selector: '.animate-pulse' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shoot = async (page, maskSelectors) => {
  const mask = maskSelectors.map((s) => page.locator(s));
  return page.screenshot({ fullPage: true, animations: 'disabled', mask, type: 'png' });
};

const equal = (a, b) => a.length === b.length && a.equals(b);

/** PNG-Maße aus dem IHDR lesen (ohne Bilddecoder). */
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

const main = async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext();
  if (TOKEN) await context.addCookies([{ name: 'studio', value: TOKEN, url: APP_URL }]);
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(APP_URL);
  const start = page.getByLabel('audioMONASTRY starten');
  if ((await start.count()) > 0) await start.first().click();
  await page.getByTitle('mixerMONK').first().waitFor({ timeout: 30_000 });
  await sleep(1_500);

  // Teilflaechen-Ansatz: kleinere, nicht live aktualisierte Bereiche sind
  // erfahrungsgemaess stabiler als die GANZE Seite (Compositor-Rasterisierung).
  for (const region of ['#rack-mixer', 'header', '#studio-main']) {
    let stable = true;
    let bytes = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const locator = page.locator(region).first();
      if ((await locator.count()) === 0) { stable = false; break; }
      const a = await locator.screenshot({ animations: 'disabled', type: 'png' });
      bytes = a.length;
      await sleep(1_500);
      const b = await locator.screenshot({ animations: 'disabled', type: 'png' });
      if (!equal(a, b)) { stable = false; console.log(`   ${region}: Unterschied (${locateDiff(a, b)})`); break; }
    }
    console.log(`Teilflaeche ${region.padEnd(16)} stabil: ${stable ? `JA (${bytes} Bytes)` : 'NEIN'}`);
  }

  for (let count = 0; count <= CANDIDATES.length; count += 1) {
    const maskSelectors = CANDIDATES.slice(0, count).map((c) => c.selector);
    let stable = true;
    let firstShot = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const a = await shoot(page, maskSelectors);
      if (!firstShot) firstShot = a;
      await sleep(1_500);
      const b = await shoot(page, maskSelectors);
      if (!equal(a, b)) {
        stable = false;
        const sa = pngSize(a);
        const sb = pngSize(b);
        console.log(`   Unterschied (Versuch ${attempt}): ${locateDiff(a, b)}`);
        console.log(`   Groessen: ${sa.width}x${sa.height} vs ${sb.width}x${sb.height}`
          + ` · Bytes ${a.length} vs ${b.length}`);
        break;
      }
    }
    const label = count === 0 ? '(ohne Masken)' : maskSelectors.join(' + ');
    console.log(`Masken: ${label.padEnd(46)} stabil: ${stable ? 'JA' : 'NEIN'}`);
    if (stable) {
      console.log(`\nErgebnis: reproduzierbar mit ${firstShot.length} Bytes, Masken = ${JSON.stringify(maskSelectors)}`);
      break;
    }
  }

  await browser.close();
};

main().catch((e) => {
  console.error('Probe fehlgeschlagen:', e);
  process.exit(1);
});
