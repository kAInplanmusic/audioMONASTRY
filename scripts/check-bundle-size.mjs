#!/usr/bin/env node
// =============================================================================
// check-bundle-size.mjs – UI-Performance-Budget (Bundle-Größe)
// -----------------------------------------------------------------------------
// Prüft die Vite-Produktions-Bundles in dist/assets auf ein Größenbudget:
//   * WARN ab 1,5 MB JavaScript (brutto)
//   * FAIL ab 2,0 MB JavaScript (brutto)
// Worklets/Server/WASM in dist/ sind getrennte Artefakte und zählen nicht.
// Aufruf:  npm run build && node scripts/check-bundle-size.mjs
// =============================================================================
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const ASSETS = path.join(DIST, 'assets');
const WARN_BYTES = 1.5 * 1024 * 1024;
const FAIL_BYTES = 2.0 * 1024 * 1024; // Doku: „FAIL ab 2.0 MB“ – hier korrekt als MiB

const jsFiles = [];
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full);
    else if (entry.name.endsWith('.js')) jsFiles.push(full);
  }
}
if (existsSync(ASSETS)) scan(ASSETS);

let totalJs = 0;
for (const f of jsFiles) totalJs += statSync(f).size;

const mb = (b) => (b / 1024 / 1024).toFixed(2);
console.log(`[bundle-size] Client-Bundle: ${jsFiles.length} JS-Dateien = ${mb(totalJs)} MB (Warn ${mb(WARN_BYTES)} MB, Fail ${mb(FAIL_BYTES)} MB)`);

if (totalJs > FAIL_BYTES) {
  console.error(`❌ Budget überschritten: ${mb(totalJs)} MB JS > ${mb(FAIL_BYTES)} MB.`);
  process.exit(1);
}
if (totalJs > WARN_BYTES) {
  console.warn(`⚠️ Warnung: ${mb(totalJs)} MB JS > ${mb(WARN_BYTES)} MB – Bundle optimieren.`);
} else {
  console.log('✅ Bundle-Budget eingehalten.');
}
