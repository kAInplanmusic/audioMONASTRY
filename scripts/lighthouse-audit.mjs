#!/usr/bin/env node
/**
 * Lighthouse-Audit (Block 5 Realtime-Performance, Block 6 Barrierefreiheit).
 *
 * WARUM DIESES SKRIPT
 * -------------------
 * Block 5 und 6 standen als "nicht messbar" still, weil zwei Dinge fehlten und
 * ich beides fuer unverzichtbar hielt:
 *   1. ein Werkzeug (Lighthouse war nicht installiert),
 *   2. eine laufende Instanz (die Flotte war aus).
 * Punkt 2 war eine falsche Annahme: Lighthouse misst eine URL. Die App laeuft
 * lokal genauso wie auf einem Knoten. Damit sind die Kernwerte von Block 5
 * (Ladezeit, Interaktivitaet, Stabilitaet) und die maschinell pruefbaren Teile
 * von Block 6 (Kontrast, Namen, Rollen, Reihenfolge) HIER messbar - auf der
 * Flotte nur zusaetzlich unter Netzbedingungen.
 *
 * WAS ES NICHT KANN
 * -----------------
 * Lighthouse sagt nichts ueber Audio. Es misst Seitenlast, nicht Klangqualitaet,
 * nicht Latenz im Audiopfad und nicht, ob vier Nutzer sich gegenseitig hoeren.
 * Die verbleibenden Block-5-Fragen brauchen echte Sitzungen, nicht dieses Skript.
 *
 * Aufruf:
 *   node scripts/lighthouse-audit.mjs                       # lokal, Port 4321
 *   DEMO_URL=https://... node scripts/lighthouse-audit.mjs  # gegen die Flotte
 *
 * Ergebnis: docs/audit/lighthouse-<host>-<datum>.json und .html
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.env.DEMO_URL ?? 'http://127.0.0.1:4321';
const ZIEL = path.join(REPO, 'docs', 'audit');

/** Die Werte, auf die es fuer Block 5/6 ankommt - mit Schwellen. */
const KENNZAHLEN = [
  { id: 'first-contentful-paint', name: 'FCP', gut: 1800, einheit: 'ms' },
  { id: 'largest-contentful-paint', name: 'LCP', gut: 2500, einheit: 'ms' },
  { id: 'total-blocking-time', name: 'TBT', gut: 200, einheit: 'ms' },
  { id: 'cumulative-layout-shift', name: 'CLS', gut: 0.1, einheit: '' },
  { id: 'speed-index', name: 'Speed Index', gut: 3400, einheit: 'ms' },
  { id: 'interactive', name: 'Interaktiv (TTI)', gut: 3800, einheit: 'ms' },
];

const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'] });
console.log(`Lighthouse gegen ${URL_} (Chrome Port ${chrome.port}) …`);

let ergebnis;
try {
  ergebnis = await lighthouse(
    URL_,
    { port: chrome.port, output: ['json', 'html'], logLevel: 'error' },
    {
      extends: 'lighthouse:default',
      settings: { formFactor: 'desktop', screenEmulation: { disabled: true }, onlyCategories: null },
    },
  );
} finally {
  await chrome.kill();
}

const bericht = ergebnis.lhr;
mkdirSync(ZIEL, { recursive: true });
const stempel = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const host = new URL(URL_).hostname.replace(/[^a-z0-9.-]/gi, '_');
const basis = path.join(ZIEL, `lighthouse-${host}-${stempel}`);

writeFileSync(`${basis}.json`, JSON.stringify(bericht, null, 2), 'utf8');
writeFileSync(`${basis}.html`, ergebnis.report.find((r) => typeof r === 'string') ?? '', 'utf8');

console.log('');
console.log('=== PUNKTE ===');
for (const [id, kategorie] of Object.entries(bericht.categories)) {
  const punkte = Math.round((kategorie.score ?? 0) * 100);
  console.log(`  ${kategorie.title.padEnd(28)} ${String(punkte).padStart(3)}/100`);
}

console.log('');
console.log('=== KENNZAHLEN (Block 5) ===');
const tabelle = [];
for (const k of KENNZAHLEN) {
  const audit = bericht.audits[k.id];
  if (!audit) continue;
  const wert = audit.numericValue ?? 0;
  const ok = wert <= k.gut;
  console.log(`  ${k.name.padEnd(14)} ${wert.toFixed(k.einheit === '' ? 3 : 0).padStart(8)} ${k.einheit.padEnd(4)} ${ok ? 'ok' : 'ZU LANGSAM'} (Schwelle ${k.gut}${k.einheit})`);
  tabelle.push({ kennzahl: k.name, wert: Number(wert.toFixed(3)), einheit: k.einheit, schwelle: k.gut, ok });
}

console.log('');
console.log('=== BARRIEREFREIHEIT (Block 6) ===');
const a11y = bericht.categories.accessibility;
console.log(`  Punkte: ${Math.round((a11y?.score ?? 0) * 100)}/100`);
const verstoesse = Object.values(bericht.audits).filter(
  (a) => a.scoreDisplayMode === 'binary' && a.score === 0 && (a.details?.items?.length ?? 0) > 0 && a.id.includes('aria') === false,
);
// Alle fehlgeschlagenen A11y-Pruefungen auflisten - das ist die Arbeitsliste.
const a11yRefs = bericht.categories.accessibility?.auditRefs ?? [];
const fehler = a11yRefs
  .map((r) => bericht.audits[r.id])
  .filter((a) => a && a.score !== null && a.score < 1)
  .map((a) => ({ id: a.id, titel: a.title, anzahl: a.details?.items?.length ?? 0 }));
if (fehler.length === 0) {
  console.log('  Keine fehlgeschlagene Pruefung.');
} else {
  for (const f of fehler) console.log(`  [${String(f.anzahl).padStart(2)}] ${f.titel}`);
}

console.log('');
console.log(`Berichte: ${path.relative(REPO, basis)}.json / .html`);
console.log(`(weitere fehlgeschlagene Pruefungen ausserhalb der A11y-Kategorie: ${verstoesse.length})`);
console.log('');
console.log('GRENZE DIESER MESSUNG: Lighthouse sieht Seitenlast, nicht Audio.');
console.log('Aussagen ueber Klangqualitaet, Latenz im Audiopfad oder vier gleichzeitige');
console.log('Nutzer braucht dieses Skript nicht zu liefern - und liefert es auch nicht.');
