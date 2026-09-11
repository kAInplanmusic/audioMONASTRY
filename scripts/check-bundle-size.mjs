#!/usr/bin/env node
// =============================================================================
// check-bundle-size.mjs – UI-Performance-Budget (Startlast des Bundles)
// -----------------------------------------------------------------------------
// Prüft die Vite-Produktions-Bundles in dist/assets auf ein Größenbudget.
//
// PERF-P3-001 (2026-09-11): Das Budget gilt jetzt ausdrücklich der **Startlast**
// (eager). Grund: das alte Gate summierte ALLE JS-Chunks und zählte damit auch
// lazy geladene Chunks mit – z. B. den 404-kB-`onnx-*.js`-Chunk, der erst beim
// optionalen lokalen ONNX-/Demucs-Pfad per `import('onnxruntime-web')` geholt
// wird. Dadurch warnte das Gate über „1,65 MB Startup", obwohl ein Viertel
// davon nie beim Start geladen wird.
//
// Eager = Entry (`index-*.js`) + alle von Vite in `dist/index.html` per
// `modulepreload` vorgeladenen Chunks (= statischer Importgraph des Entry).
// Lazy  = alle übrigen JS-Chunks (informativ, kein Fail – sie kosten erst bei
//         Nutzung, z. B. Plugin-Terminals, ONNX-Runtime).
//
//   * WARN ab 1,5 MB eager · FAIL ab 2,0 MB eager
//   * Lazy-Chunks werden gemeldet (Top 3) und mitgezählt, aber nicht gewertet
//   * Worklets/Server/WASM in dist/ sind getrennte Artefakte und zählen nicht
//
// Aufruf:  npm run build && node scripts/check-bundle-size.mjs
// =============================================================================
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const ASSETS = path.join(DIST, 'assets');
const WARN_BYTES = 1.5 * 1024 * 1024;
const FAIL_BYTES = 2.0 * 1024 * 1024; // Doku: „FAIL ab 2.0 MB“ – hier korrekt als MiB

const allJs = [];
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full);
    else if (entry.name.endsWith('.js')) allJs.push(full);
  }
}
if (existsSync(ASSETS)) scan(ASSETS);

/** Chunks, die der Browser beim Start lädt: Entry + modulepreload aus index.html. */
const eagerNames = new Set();
const indexHtml = path.join(DIST, 'index.html');
if (existsSync(indexHtml)) {
  const html = readFileSync(indexHtml, 'utf8');
  for (const m of html.matchAll(/\/assets\/([A-Za-z0-9._-]+\.js)/g)) eagerNames.add(m[1]);
}
const eager = allJs.filter((f) => eagerNames.has(path.basename(f)));
const lazy = allJs.filter((f) => !eagerNames.has(path.basename(f)));

const sizeOf = (files) => files.reduce((sum, f) => sum + statSync(f).size, 0);
const eagerBytes = sizeOf(eager);
const lazyBytes = sizeOf(lazy);
const mb = (b) => (b / 1024 / 1024).toFixed(2);

console.log(
  `[bundle-size] Startlast (eager): ${eager.length} Dateien = ${mb(eagerBytes)} MB ` +
  `(Warn ${mb(WARN_BYTES)} MB, Fail ${mb(FAIL_BYTES)} MB)`,
);
console.log(`[bundle-size] Lazy (bei Nutzung): ${lazy.length} Dateien = ${mb(lazyBytes)} MB – informativ`);

const top = (files, n) => [...files].sort((a, b) => statSync(b).size - statSync(a).size).slice(0, n);
const fmt = (f) => `${path.basename(f)} ${(statSync(f).size / 1024).toFixed(0)} KB`;
if (eager.length > 0) console.log(`[bundle-size]   größte Startlast-Chunks: ${top(eager, 3).map(fmt).join(' · ')}`);
if (lazy.length > 0) console.log(`[bundle-size]   größte Lazy-Chunks:      ${top(lazy, 3).map(fmt).join(' · ')}`);

if (eagerBytes > FAIL_BYTES) {
  console.error(`❌ Budget überschritten: ${mb(eagerBytes)} MB Startlast > ${mb(FAIL_BYTES)} MB.`);
  process.exit(1);
}
if (eagerBytes > WARN_BYTES) {
  console.warn(`⚠️ Warnung: ${mb(eagerBytes)} MB Startlast > ${mb(WARN_BYTES)} MB – Bundle optimieren.`);
} else {
  console.log('✅ Bundle-Budget (Startlast) eingehalten.');
}
