// ARCH-P2-002: Wächter für scripts/route-dependency-graph.py.
// Die drei Blindstellen der ersten Fassung sind je Fixture abgesichert - jede hatte
// beim Umsetzen real zugeschlagen (fleetTargets/tsc, Regex-Literal/Importe,
// vorgezogene Route/Vollständigkeitsprüfung). Siehe docs/ARCH_P2_002_DEPENDENCY_GRAPH.md.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(__dirname, '../scripts/route-dependency-graph.py');
const fixture = (name: string) => resolve(__dirname, `fixtures/routeDepGraph/${name}`);

interface Statement { method: string; path: string; start: number; end: number }
interface DepSplit { state: string[]; helper: string[]; imports: string[] }
interface Group {
  prefix: string;
  statements: Statement[];
  areas: number[][];
  deps: { state: string[]; helper: string[] };
  imported: string[];
  movable: DepSplit;
  shared: DepSplit;
}
interface Graph {
  lines: number;
  routes: number;
  imports: number;
  moduleScope: { declarations: number; state: string[]; helpers: string[] };
  groups: Group[];
}

function graph(file: string): Graph {
  const out = execFileSync('python3', [script, '--json', '--file', file], { encoding: 'utf8' });
  return JSON.parse(out) as Graph;
}

function groupOf(data: Graph, prefix: string): Group {
  const found = data.groups.find((g) => g.prefix === prefix);
  if (!found) {
    throw new Error(`Gruppe ${prefix} fehlt; vorhanden: ${data.groups.map((g) => g.prefix).join(', ')}`);
  }
  return found;
}

describe('route-dependency-graph (ARCH-P2-002)', () => {
  it('Blindstelle 1: verfolgt Abhängigkeiten transitiv über blockeigene Helfer', () => {
    const g = groupOf(graph(fixture('transitive.ts')), '/api/demo');
    expect(g.deps.helper).toContain('helperA');
    // Eine Ebene tiefer - genau das fehlte der ersten Fassung (dort fiel es erst tsc auf).
    expect(g.deps.helper).toContain('sharedTarget');
    expect(g.deps.state).toContain('counter');
  });

  it('Blindstelle 2: Regex-Literale mit Anführungszeichen desynchronisieren den Scanner nicht', () => {
    const data = graph(fixture('regexLiteral.ts'));
    expect(data.routes).toBe(1);
    const g = groupOf(data, '/api/demo');
    expect(g.statements.map((s) => s.path)).toEqual(['/api/demo/strip']);
    // Ohne Regex-Erkennung läge der Scanner still: hits/strip wären nicht auffindbar.
    expect(g.deps.state).toContain('hits');
    expect(g.deps.helper).toContain('strip');
  });

  it('Blindstelle 3: eine Gruppe umfasst ALLE Bereiche, nicht nur einen Block', () => {
    const data = graph(fixture('twoBlocks.ts'));
    const demo = groupOf(data, '/api/demo');
    expect(demo.statements).toHaveLength(2);
    expect(demo.areas).toHaveLength(2); // nicht zusammenhängend
    expect(demo.deps.helper).toContain('shared');
    expect(groupOf(data, '/api/other').statements).toHaveLength(1);
  });

  it('zählt Modul-Zustand korrekt - auch Deklarationen ohne Klammern', () => {
    // `const app: any = {}` und `let counter = 0` stehen direkt hintereinander; eine
    // naiv klammerbasierte Bereichs Erkennung verschluckte hier echte Deklarationen.
    const data = graph(fixture('transitive.ts'));
    expect(data.moduleScope.state).toEqual(['counter']);
    expect(data.moduleScope.declarations).toBe(4); // app, sharedTarget, counter, helperA
  });

  it('--plan nennt beide Bereiche einer nicht zusammenhängenden Gruppe', () => {
    const out = execFileSync('python3', [script, '--file', fixture('twoBlocks.ts'), '--plan', '/api/demo'], {
      encoding: 'utf8',
    });
    expect(out).toContain('Zu verschiebende Bereiche');
    expect(out).toContain('/api/demo/a');
    expect(out).toContain('/api/demo/c');
  });

  it('trennt "kann mitwandern" von "muss gereicht werden"', () => {
    const g = groupOf(graph(fixture('transitive.ts')), '/api/demo');
    // Nur in dieser Gruppe referenziert -> darf ins neue Modul wandern.
    expect(g.movable.helper).toEqual(expect.arrayContaining(['helperA', 'sharedTarget']));
    expect(g.movable.state).toContain('counter');
    // Gruppenlokale Helfer wandern mit, sie werden nicht gereicht.
    expect(g.shared.helper).not.toContain('helperA');
    expect(g.shared.state).not.toContain('counter');
  });

  it('teilt einen Namen, den mehrere Gruppen brauchen, korrekt als geteilt ein', () => {
    const data = graph(fixture('twoBlocks.ts'));
    // `shared` liegt ausschließlich im /api/demo-Bereich -> mitwanderbar.
    expect(groupOf(data, '/api/demo').movable.helper).toContain('shared');
    // Die fremde Gruppe nutzt es nicht, muss aber `app` gereicht bekommen.
    const other = groupOf(data, '/api/other');
    expect(other.shared.helper).toContain('app');
    expect(other.movable.helper).not.toContain('shared');
  });

  it('wertet eine Import-Zeile als Deklaration, nicht als externe Nutzung', () => {
    // Ohne das gilt jeder Import als "muss gereicht werden" - genau der Fehler,
    // der beim AI-Block fast Importe aus server.ts gelöscht hätte.
    const g = groupOf(graph(fixture('regexLiteral.ts')), '/api/demo');
    expect(g.imported).toContain('randomUUID');
    expect(g.movable.imports).toContain('randomUUID');
    expect(g.shared.imports).toEqual([]);
  });

  it('rechnet mehrere Präfixe als EINE Gruppe (Familie mit geteilten Helfern)', () => {
    const out = execFileSync(
      'python3',
      [script, '--file', fixture('twoBlocks.ts'), '--plan', '/api/demo,/api/other'],
      { encoding: 'utf8' },
    );
    expect(out).toContain('PLAN /api/demo+/api/other');
    expect(out).toContain('/api/demo/a');
    expect(out).toContain('/api/other/b');
    // In der gemeinsamen Sicht ist `app` nicht mehr "geteilt" zwischen den Gruppen,
    // es liegt in beiden Bereichen - aber es kommt weiterhin von aussen.
    expect(out).toContain('/api/demo/c');
  });

  it('analysiert die echte server.ts ohne Fehler', () => {
    const data = graph(resolve(__dirname, '../server.ts'));
    expect(data.routes).toBeGreaterThan(0);
    expect(data.moduleScope.state.length).toBeGreaterThan(0);
    // Die /api/ai-Routen sind extrahiert. Als Gruppe bleibt /api/ai nur wegen der
    // app.use-Rate-Limit-Zeile (Middleware) - die gehoert bewusst hierher.
    const aiStatements = data.groups
      .filter((g) => g.prefix === '/api/ai' || g.prefix.startsWith('/api/ai/'))
      .flatMap((g) => g.statements);
    expect(aiStatements.filter((s) => s.method !== 'use')).toEqual([]);
  });
});
