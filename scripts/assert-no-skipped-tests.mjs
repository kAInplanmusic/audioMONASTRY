#!/usr/bin/env node
/**
 * assert-no-skipped-tests.mjs
 * ===========================
 * Gate gegen stillen Coverage-Verlust (CI-P1-001): Ein `it.skip`/`it.todo` im
 * Unit-/Integrationstest darf nicht unbemerkt in CI bestehen bleiben — sonst
 * sieht „1138 Tests grün" gut aus, obwohl ein Test gar nicht lief.
 *
 * Aufruf:
 *   node scripts/assert-no-skipped-tests.mjs [report.json]
 *   (Default: .vitest-report.json)
 *
 * Erwartet den JSON-Reporter von Vitest. Exit-Code 1, wenn etwas übersprungen
 * oder als todo markiert wurde.
 *
 * Bewusste Abgrenzung: Playwright-E2E-Specs nutzen **begründete bedingte**
 * Skips (`test.skip(bedingung, 'Grund')`), z. B. wenn die Browser-Umgebung
 * keinen Audio-Graph hat. Für E2E gilt deshalb `--forbid-only` statt eines
 * pauschalen Skip-Verbots; die Gründe stehen im Code. Dieses Gate gilt für die
 * Vitest-Suite, in der es (Stand 2026-09-11) null Skips gibt.
 */
import { readFileSync } from 'node:fs';

const reportPath = process.argv[2] ?? '.vitest-report.json';

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.error(`❌ Kein lesbarer Vitest-Report unter ${reportPath}: ${e.message}`);
  console.error('   Aufruf in CI: npm run test:ci (schreibt den Report und prüft ihn).');
  process.exit(1);
}

const files = Array.isArray(report.testResults) ? report.testResults : [];
const pending = [];
const todo = [];
let total = 0;
let passed = 0;

// Vitest-Status im JSON-Report: 'passed' | 'failed' | 'skipped' | 'todo'.
// `it.skip` erscheint als 'skipped' (NICHT 'pending' – live geprüft 2026-09-11,
// der erste Entwurf dieses Gates hat genau das übersehen und war damit wertlos).
const SKIPPED_STATUSES = new Set(['skipped', 'pending', 'disabled']);

for (const file of files) {
  for (const test of file.assertionResults ?? []) {
    total += 1;
    if (test.status === 'passed') passed += 1;
    if (SKIPPED_STATUSES.has(test.status)) pending.push(`${file.name} › ${test.fullName ?? test.title}`);
    if (test.status === 'todo') todo.push(`${file.name} › ${test.fullName ?? test.title}`);
  }
}

// Zusätzlich die Zähler des Reporters prüfen: falls ein künftiges Vitest-Update
// einen neuen Status einführt, fällt es hier auf, statt still durchzugehen.
const reportedPending = Number(report.numPendingTests ?? 0);
const reportedTodo = Number(report.numTodoTests ?? 0);
const counterMismatch = reportedPending + reportedTodo > pending.length + todo.length;

const skipped = [...pending, ...todo];
console.log(`Vitest-Report: ${reportPath}`);
console.log(`  Dateien: ${files.length} · Tests: ${total} · bestanden: ${passed}`);
console.log(`  übersprungen: ${pending.length} (Reporter: ${reportedPending}) · todo: ${todo.length} (Reporter: ${reportedTodo})`);

if (skipped.length > 0 || counterMismatch) {
  console.log('\n❌ Übersprungene/Todo-Tests gefunden — CI soll deswegen rot werden:');
  for (const s of skipped.slice(0, 40)) console.log(`   - ${s}`);
  if (skipped.length > 40) console.log(`   … und ${skipped.length - 40} weitere`);
  if (counterMismatch) {
    console.log(`   ⚠ Reporter zählt ${reportedPending} übersprungene / ${reportedTodo} todo,`);
    console.log('     die Auswertung fand aber weniger Einträge — Statusauswertung prüfen.');
  }
  console.log('\nEntweder den Test wieder aktivieren oder begründet entfernen.');
  process.exit(1);
}

if (total === 0) {
  console.log('\n❌ Der Report enthält keinen einzigen Test — das ist kein grüner Lauf.');
  process.exit(1);
}

console.log('\n✅ Keine übersprungenen Tests.');
