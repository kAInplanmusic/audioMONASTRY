#!/usr/bin/env node
/**
 * "Wie ist der RLS-Abgleich zuletzt ausgegangen?" - in einer Ausgabe.
 *
 * Der Betreiber hat entschieden: kein Alarmkanal, nur Protokoll. Dann muss die
 * Antwort auf diese Frage billig sein - sonst sieht niemand nach. Dieses Skript
 * ist genau dafuer da: eine Zeile fuer den letzten Lauf, dazu die offenen
 * Probleme. Aufruf: npm run rls:status
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(REPO, 'logs');
const STATUS = path.join(LOG_DIR, 'rls-nightly.status');
const PROBLEME = path.join(LOG_DIR, 'rls-nightly-problems.log');
const PROTOKOLL = path.join(LOG_DIR, 'rls-nightly.log');

function lies(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

console.log('=== RLS-Nachlauf (DB-P2-002) ===');
console.log('Zeitplan: taeglich 07:30 (systemd-User-Timer audioMONASTRY-rls-check.timer)');
console.log('Grund fuer 07:30 und nicht nachts: der Alarmmanager puffert 22-07 Uhr.');
console.log('');

const status = lies(STATUS);
if (!status) {
  console.log('Noch kein Lauf protokolliert.');
  console.log('Erster Lauf: morgen 07:30. Sofort testen:');
  console.log('  systemctl --user start audioMONASTRY-rls-check.service');
} else {
  console.log(`LETZTER LAUF: ${status.trim()}`);
}

const probleme = lies(PROBLEME);
if (probleme === null) {
  console.log('OFFENE PROBLEME: keine - die Problemdatei existiert nicht.');
} else {
  const zeilen = probleme.split('\n').filter(Boolean);
  console.log(`OFFENE PROBLEME: ${zeilen.length} (Datei wird nie rotiert)`);
  for (const z of zeilen.slice(-10)) console.log(`  ${z}`);
  if (zeilen.length > 10) console.log(`  … und ${zeilen.length - 10} weitere`);
}

const protokoll = lies(PROTOKOLL);
if (protokoll) {
  const zeilen = protokoll.split('\n').filter(Boolean);
  console.log('');
  console.log(`Protokoll: ${zeilen.length} Zeilen (rollierend, letzte 2000)`);
  for (const z of zeilen.slice(-3)) console.log(`  ${z}`);
}

console.log('');
console.log('Kein Alarmkanal konfiguriert (Entscheidung des Betreibers 2026-09-24):');
console.log('ein Befund steht nur hier. Deshalb gibt es die Problemdatei, die nicht rotiert.');
