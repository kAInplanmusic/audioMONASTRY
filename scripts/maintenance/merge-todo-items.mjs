#!/usr/bin/env node
/**
 * audioMONASTRY · SSOT-Pflege: Eintraege in MASTERTODOENDE.json mergen
 * ============================================================================
 * Warum es dieses Skript gibt:
 *
 * `MASTERTODOENDE.json` ist die eine Quelle fuer den Umsetzungsstand. Die Liste
 * ist zu gross und zu fehleranfaellig, um sie von Hand zu editieren (ein
 * vergessenes Komma kostet die ganze Datei, und ein Eintrag ohne `note`/
 * `verification` behauptet Erledigung ohne Nachweis). Deshalb schreibt dieses
 * Skript die Eintraege: es liest die SSOT, ersetzt Items mit gleicher `id` und
 * haengt neue hinten an - die Reihenfolge der bestehenden Eintraege bleibt
 * unveraendert.
 *
 * Aufruf:
 *   node scripts/maintenance/merge-todo-items.mjs <payload.json> [--dry-run]
 *
 * Payload: `[{...item}, ...]` oder `{"items":[{...item}, ...]}`.
 * Pflichtfelder je Item: id, title, status (siehe statusVocabulary der SSOT).
 * Empfohlen fuer DONE/PARTIAL: note (was wurde gemacht) und verification
 * (gemessene Befehle/Ergebnisse) - ohne die ist der Eintrag eine Behauptung.
 *
 * Zusaetzlich werden `generatedAt` (heutiges Datum) und `commit` (kurzer SHA des
 * HEAD) der SSOT aktualisiert, damit der Stand der Liste nachvollziehbar ist.
 *
 * Das Skript ist bewusst ohne Abhaengigkeiten und ohne Netz: reines Node.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REQUIRED = ['id', 'title', 'status'];
/** Kanonische Feldreihenfolge - neue Items erscheinen damit lesbar sortiert. */
const FIELD_ORDER = [
  'id', 'title', 'priority', 'status', 'area', 'source', 'problem', 'note',
  'verification', 'acceptance', 'files', 'remaining', 'live_open', 'blockedReason',
];

const [payloadArg, ...flags] = process.argv.slice(2);
if (!payloadArg) {
  console.error('Aufruf: node scripts/maintenance/merge-todo-items.mjs <payload.json> [--dry-run]');
  process.exit(2);
}
const dryRun = flags.includes('--dry-run');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const todoPath = path.join(root, 'MASTERTODOENDE.json');

function orderItem(item) {
  const out = {};
  for (const key of FIELD_ORDER) {
    if (item[key] !== undefined) out[key] = item[key];
  }
  for (const [key, value] of Object.entries(item)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

function headCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unbekannt';
  }
}

const payloadRaw = JSON.parse(readFileSync(payloadArg, 'utf8'));
const incoming = Array.isArray(payloadRaw) ? payloadRaw : payloadRaw.items;
if (!Array.isArray(incoming) || incoming.length === 0) {
  console.error('Payload enthaelt keine Items.');
  process.exit(2);
}
for (const item of incoming) {
  for (const field of REQUIRED) {
    if (typeof item[field] !== 'string' || item[field].trim() === '') {
      console.error(`Item ${item.id ?? '(ohne id)'}: Pflichtfeld "${field}" fehlt.`);
      process.exit(2);
    }
  }
}

const doc = JSON.parse(readFileSync(todoPath, 'utf8'));
const items = doc.items ?? [];
const indexById = new Map(items.map((item, index) => [item.id, index]));

const added = [];
const updated = [];
for (const item of incoming) {
  const ordered = orderItem(item);
  const existing = indexById.get(item.id);
  if (existing === undefined) {
    indexById.set(item.id, items.length);
    items.push(ordered);
    added.push(item.id);
  } else {
    items[existing] = ordered;
    updated.push(item.id);
  }
}

doc.items = items;
doc.generatedAt = new Date().toISOString().slice(0, 10);
doc.commit = headCommit();

const serialized = `${JSON.stringify(doc, null, 2)}\n`;
if (dryRun) {
  console.log(`Trockenlauf: ${added.length} neu, ${updated.length} ersetzt, ${items.length} Items gesamt.`);
  if (added.length) console.log(`  neu:      ${added.join(', ')}`);
  if (updated.length) console.log(`  ersetzt:  ${updated.join(', ')}`);
  process.exit(0);
}
writeFileSync(todoPath, serialized);
console.log(`MASTERTODOENDE.json geschrieben: ${added.length} neu, ${updated.length} ersetzt, ${items.length} Items gesamt.`);
if (added.length) console.log(`  neu:      ${added.join(', ')}`);
if (updated.length) console.log(`  ersetzt:  ${updated.join(', ')}`);
