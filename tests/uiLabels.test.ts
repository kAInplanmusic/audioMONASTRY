import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// UI2-P1-004: Verbindlich sind die Modulnamen der README (16 Plugins plus
// mastergraphMONK, aiMONK, perforMONK). Sichtbare Texte dürfen keine anderen
// *MONK-Namen tragen, keine Tippfehler und keine Platzhalter.
// ---------------------------------------------------------------------------

const ALLOWED = new Set([
  'mixerMONK', 'dropMONK', 'songMONK', 'effectMONK', 'syntisamplerMONK', 'drumsamplerMONK',
  'instruMONK', 'biblioMONK', 'voiceMONK', 'soundMONK', 'stemMONK', 'spatialMONK',
  'eqMONK', 'dspMONK', 'masterMONK', 'recordMONK',
  'mastergraphMONK', 'aiMONK', 'perforMONK',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Zeilen ohne reine Kommentare (JSDoc, //, JSX-Kommentar). */
function codeLines(file: string): { line: number; text: string }[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => !/^\s*(\*|\/\/|\/\*|\{\/\*)/.test(text));
}

const files = sourceFiles(join(__dirname, '..', 'src'));

describe('Verlabelung (UI2-P1-004)', () => {
  it('sichtbare Modulnamen stammen nur aus der README-Liste', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const { line, text } of codeLines(f)) {
        // Name direkt als JSX-Text (>name) oder als String-Anfang ('name', "name", `name`).
        for (const m of text.matchAll(/[>'"`]([a-zA-Z]+MONK)\b/g)) {
          if (!ALLOWED.has(m[1])) bad.push(`${f}:${line} ${m[1]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('keine bekannten Tippfehler und Platzhalter', () => {
    const bad: string[] = [];
    const pattern = /masteringrevMONK|MiserMONK|audioMONKSTRY|TEXTEINGABE\s*FELD/i;
    for (const f of files) {
      for (const { line, text } of codeLines(f)) {
        if (pattern.test(text)) bad.push(`${f}:${line}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
