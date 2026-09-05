#!/usr/bin/env node
/**
 * P2-5: UI-Audit – prüft, dass alle Terminal-Komponenten React.memo nutzen.
 * Aufruf: node scripts/check-react-memo.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENTS = path.join(ROOT, 'src', 'components');

const files = readdirSync(COMPONENTS).filter((f) => f.endsWith('.tsx') && /Terminal|Scene|Dock|DJMixer/.test(f));
const missing = [];
for (const f of files) {
  const src = readFileSync(path.join(COMPONENTS, f), 'utf8');
  if (!/React\.memo/.test(src) && !/memo\(/.test(src)) {
    missing.push(f);
  }
}
if (missing.length > 0) {
  console.error(`❌ React.memo fehlt in ${missing.length} Terminal-/Panel-Komponenten: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`✅ React.memo-Audit ok (${files.length} Terminal-/Panel-Komponenten geprüft).`);
