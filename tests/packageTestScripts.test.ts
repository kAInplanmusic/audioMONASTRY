/**
 * Waechter: ein "test"-Skript muss Tests ausfuehren (DA-2026-09-29-049).
 * =====================================================================
 * Deep-Audit-Befunde F69/F70/F75: `services/backend-core` und
 * `services/backend-core/node` deklarierten `"test": "node --check …"` - das ist
 * eine SYNTAXPRUEFUNG. Ein Aufruf von `npm test` lief damit gruen durch, obwohl
 * keine einzige Zusicherung geprueft wurde; wer sich auf das Ergebnis verliess,
 * bekam ein falsches Signal.
 *
 * Behoben ist das an der Ursache: die Syntaxpruefung heisst jetzt `check:syntax`
 * (sie ist nuetzlich - nur nicht als Test getarnt). Dieser Waechter verhindert,
 * dass die Tarnung beim naechsten Paket zurueckkommt.
 *
 * Nicht betroffen: das npm-Standardskelett `echo "Error: no test specified" &&
 * exit 1` - es faellt laut durch und behauptet keinen Erfolg.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

/** Alle getrackten package.json (ohne node_modules, die sind nicht getrackt). */
function packageFiles(): string[] {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((file) => file === 'package.json' || file.endsWith('/package.json'))
    .filter((file) => !file.includes('node_modules/'));
}

const packages = packageFiles().map((file) => ({
  file,
  json: JSON.parse(readFileSync(file, 'utf8')) as PackageJson,
}));

describe('DA-2026-09-29-049 · "test"-Skripte fuehren Tests aus', () => {
  it('findet die Pakete im Baum', () => {
    // Sanity: ohne Treffer wuerde der Waechter nichts pruefen.
    expect(packages.length).toBeGreaterThan(2);
    expect(packages.some((p) => p.file === 'package.json')).toBe(true);
  });

  it('tarnt keine Syntaxpruefung als Testsuite', () => {
    const violations: string[] = [];
    for (const { file, json } of packages) {
      const test = (json.scripts?.test ?? '').trim();
      if (!test) continue;
      // Zerlegt in Einzelbefehle: `node --check x.js` in beliebiger Position.
      const commands = test.split('&&').map((part) => part.trim());
      const onlySyntaxChecks = commands.every(
        (cmd) => /^node\s+(--check|-c)\b/.test(cmd) || cmd === '',
      );
      if (onlySyntaxChecks) {
        violations.push(
          `${file}: "test" ist nur eine Syntaxpruefung (${test}) - bitte "check:syntax" nennen`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('haelt die behobenen Pakete auf check:syntax', () => {
    // Die beiden Fundstellen aus dem Audit: die Syntaxpruefung bleibt erhalten,
    // aber unter ihrem richtigen Namen.
    const expected: Record<string, string> = {
      'services/backend-core/package.json': 'node --check node/index.js',
      'services/backend-core/node/package.json': 'node --check index.js',
    };
    for (const [file, command] of Object.entries(expected)) {
      const entry = packages.find((p) => p.file === file);
      expect(entry, `${file} fehlt`).toBeDefined();
      expect(entry?.json.scripts?.['check:syntax']).toBe(command);
      expect(entry?.json.scripts?.test).toBeUndefined();
    }
  });

  it('laesst das ehrliche npm-Skelett in Ruhe', () => {
    // Pakete ohne eigene Suite duerfen `exit 1` behalten - das ist kein
    // falsch-gruenes Signal und wird hier bewusst nicht erzwungen.
    const honest = packages.filter(({ json }) =>
      (json.scripts?.test ?? '').includes('no test specified'),
    );
    for (const { file, json } of honest) {
      expect(json.scripts?.test, file).toContain('exit 1');
    }
  });
});
