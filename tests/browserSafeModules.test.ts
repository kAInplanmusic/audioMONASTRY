/**
 * Browser-Tauglichkeit der `src/`-Module (Regressionsschutz)
 * =====================================================================
 * Anlass: `src/core/ai/MoaAgent.ts` las `process.env` auf MODULEBENE. Diese Datei
 * landet über `MoaAssistant` im Browser-Bundle, und Vite definiert `process`
 * nicht — die App rendete leer:
 *
 *   Uncaught ReferenceError: process is not defined,
 *   source: http://localhost:8080/src/core/ai/MoaAgent.ts (60)
 *
 * Aufgefallen ist das erst im Zwei-Browser-E2E (`tests/e2e/collab.spec.ts`), weil
 * alle Node-Tests ein `process` haben. Der Fehler hätte jede Auslieferung
 * lahmgelegt.
 *
 * Der Test prüft deshalb nicht „irgendwo in src/", sondern genau die Module, die
 * vom Client wirklich erreicht werden: der Importgraph ab `src/main.tsx` wird
 * aufgelöst (nur relative Importe, `import type` fällt weg, weil es gelöscht
 * wird). Für diese Menge gilt:
 *
 *   1. kein `process`-Zugriff auf Modulebene (läuft beim Import),
 *   2. `process.env` nur mit `typeof process`-Absicherung.
 *
 * Das hält Server-Module unter `src/` (die `process` legitim nutzen) aus dem
 * Weg, ohne die Grenze zu verwischen.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function resolveImport(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    path.join(base, 'index.ts'), path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Alle Module, die der Client ab src/main.tsx tatsaechlich laedt. */
function clientReachableModules(): string[] {
  const seen = new Set<string>();
  const queue = [path.join(ROOT, 'src/main.tsx')];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const importRe = /^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      if (!match[1].startsWith('.')) continue; // Pakete
      if (/^\s*import\s+type\b/.test(match[0])) continue; // wird geloescht
      const target = resolveImport(file, match[1]);
      if (target) queue.push(target);
    }
  }
  return [...seen].map((file) => path.relative(ROOT, file)).sort();
}

const reachable = clientReachableModules();
const isComment = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

describe('Browser-Tauglichkeit der client-erreichbaren Module', () => {
  it('loest den Importgraphen auf (Selbsttest des Waechters)', () => {
    // Findet der Waechter nichts, ist er wertlos - deshalb eine Untergrenze.
    expect(reachable.length).toBeGreaterThan(50);
    expect(reachable).toContain('src/main.tsx');
    expect(reachable).toContain('src/core/ai/MoaAgent.ts');
    // Server-only-Module stehen bewusst NICHT darin.
    expect(reachable).not.toContain('src/core/ai/agentRuns.ts');
  });

  it('hat keinen process-Zugriff auf Modulebene', () => {
    const offenders: string[] = [];
    for (const file of reachable) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (isComment(line)) return;
        if (/^(export\s+)?(const|let|var)\s+[^=]*=\s*[^;]*\bprocess\b/.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('sichert jeden process.env-Zugriff gegen fehlendes process ab', () => {
    const unguarded = reachable.filter((file) => {
      const content = readFileSync(file, 'utf8');
      if (!/\bprocess\.env\b/.test(content)) return false;
      return !/typeof\s+process\s*(!==|===)\s*['"]undefined['"]/.test(content);
    });
    expect(unguarded).toEqual([]);
  });

  it('haelt die konkret betroffenen Module korrekt', () => {
    const moa = readFileSync('src/core/ai/MoaAgent.ts', 'utf8');
    expect(moa).toContain("typeof process === 'undefined'");
    expect(moa).not.toMatch(/^export const [A-Z_]+ = Number\(process/m);

    expect(readFileSync('src/utils/LocalEmbeddingProvider.ts', 'utf8')).toContain("typeof process === 'undefined'");
    expect(readFileSync('src/core/ai/orchestrator/aiLogger.ts', 'utf8')).toContain("typeof process === 'undefined'");
  });
});
