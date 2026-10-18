/**
 * Waechter: Code nennt nur Doku, die es gibt (DOC-2026-10-13-001).
 * =================================================================
 * Der Bereinigungs-Commit 6dc1c35e hat 20+ Dokumente geloescht - darunter
 * Dateien, die Code-Kommentare und Tests als Begruendung nennen. Niemand hat es
 * gemerkt, weil kein Test die Verweise pruefte: die Suite blieb gruen, waehrend
 * der Kommentar auf eine nicht mehr existierende Quelle zeigte.
 *
 * Dieser Test zieht die Grenze dort, wo sie ziehbar ist: JEDER `docs/*.md`-Pfad,
 * der in getracktem CODE (nicht in Doku ueber Doku) steht, muss existieren.
 * Ausnahmen brauchen einen Grund in der Liste unten - damit ein toter Verweis
 * eine bewusste Entscheidung ist und kein Versehen.
 *
 * Absichtlich NICHT geprueft: Verweise INNERHALB von Dokumenten. Historische
 * Belegkapitel (z. B. docs/AUDIT_REPORT_2026-09-23.md) nennen geloeschte
 * Vorlagen als Messergebnis; sie umzuschreiben wuerde die Belege falschen
 * (Repo-Regel: Vergangenes wird nicht umgeschrieben).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Pfade, die absichtlich NICHT im Baum liegen - mit Begruendung.
 * Ein Eintrag ohne Grund ist ein Fehler, kein Freibrief.
 */
const ALLOWED: Record<string, string> = {
  'docs/en/INFERENCE.md':
    'Pfad im UPSTREAM-Repo github.com/ace-step/ACE-Step-1.5 (dortige API-Doku), '
    + 'nicht in unserem Baum - der Kommentar zitiert den fremden Vertrag samt Quelle.',
};

interface Reference {
  doc: string;
  files: string[];
}

/** Alle `docs/…md`-Verweise aus getracktem Code (Doku selbst ausgenommen). */
function codeReferences(): Reference[] {
  const args = [
    'grep', '-o', '-I', '-E', 'docs/[A-Za-z0-9_./-]+\\.md',
    '--',
    '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.py', '*.sh', '*.yml', '*.yaml',
    '*.json', '*.html', '*.css',
    'README.md', 'AGENTS.md',
    ':(exclude)node_modules/**',
    ':(exclude)dist/**',
    // Die SSOT fuehrt in `files`/`source`/`reports` HISTORISCHE Pfade ihrer
    // Tickets (Audit-Regel: Vergangenes wird nicht umgeschrieben); sie ist
    // Ticket-Historie und keine Aussage "diese Doku gibt es".
    ':(exclude)MASTERTODOENDE.json',
  ];
  let raw = '';
  try {
    raw = execFileSync('git', args, { encoding: 'utf8' });
  } catch (err) {
    // Exit 1 = kein Treffer. Dann gibt es nichts zu pruefen (und nichts zu retten).
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  const byDoc = new Map<string, Set<string>>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const file = line.slice(0, separator);
    const doc = line.slice(separator + 1).trim();
    if (!byDoc.has(doc)) byDoc.set(doc, new Set());
    byDoc.get(doc)?.add(file);
  }
  return [...byDoc.entries()]
    .map(([doc, files]) => ({ doc, files: [...files].sort() }))
    .sort((a, b) => a.doc.localeCompare(b.doc));
}

const references = codeReferences();

describe('DOC-2026-10-13-001 · Code verweist nur auf existierende Doku', () => {
  it('findet ueberhaupt Verweise (sonst prueft der Waechter nichts)', () => {
    // Sanity-Check: bricht der Scan (z. B. durch ein falsches Pathspec), waere
    // der Test sonst still gruen - genau der Fehler, den er verhindern soll.
    expect(references.length).toBeGreaterThan(20);
  });

  it('nennt in Code und Einstiegsdateien keine geloeschte Doku', () => {
    const missing = references
      .filter((ref) => !ALLOWED[ref.doc])
      .filter((ref) => !existsSync(ref.doc))
      .map((ref) => `${ref.doc} (genannt in ${ref.files.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('haelt die Ausnahmeliste begruendet und aktuell', () => {
    const stale: string[] = [];
    for (const [doc, reason] of Object.entries(ALLOWED)) {
      if (!reason || reason.trim().length < 20) stale.push(`${doc}: Begruendung fehlt`);
      // Eine Ausnahme fuer einen Pfad, den niemand mehr nennt, ist eine offene
      // Flanke - sie wuerde einen spaeteren toten Verweis decken.
      if (!references.some((ref) => ref.doc === doc)) stale.push(`${doc}: wird nicht mehr genannt`);
    }
    expect(stale).toEqual([]);
  });
});
