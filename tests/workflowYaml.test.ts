import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Guard für die GitHub-Workflows.
 *
 * Anlass: ein Doppelpunkt mit Leerzeichen mitten in einem Step-Namen
 * (`- name: Probe 9 – Brain: Gewichte …`) macht die YAML ungültig. GitHub legt
 * dann einen Lauf **ganz ohne Jobs** an – der Fehler ist in den Actions-Logs
 * nicht zu sehen und kostet einen kompletten CI-Zyklus. Hier fällt er sofort auf.
 */
const workflowDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

describe('GitHub-Workflows sind valides YAML', () => {
  const files = readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  it('findet überhaupt Workflows', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} parst und hat Jobs`, () => {
      const text = readFileSync(`${workflowDir}${file}`, 'utf-8');
      const doc = parse(text) as { jobs?: Record<string, unknown> } | null;
      expect(doc, `${file} ist kein YAML-Objekt`).toBeTruthy();
      const jobs = doc?.jobs ?? {};
      expect(Object.keys(jobs).length, `${file} hat keine Jobs`).toBeGreaterThan(0);
    });
  }
});
