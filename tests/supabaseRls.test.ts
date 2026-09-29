import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * GAP-4 · Supabase-RLS-Vertrag (statisch, zustandsbasiert)
 * ======================================================
 * Vorgeschichte: Der Test pruefte frueher nur drei Dateien und verlangte fuer
 * JEDE Tabelle genau eine `anon`-SELECT-Policy. Damit war eine unnoetige
 * oeffentliche Freigabe per Test festgeschrieben - `anon` durfte
 * `ai_sessions`, `ai_jobs`, `ai_errors`, `ai_cost_estimates`, `mcp_audit_events`
 * und die Prompt-/Eval-Tabellen lesen, obwohl der Browser sie nie anfasst.
 *
 * RC1-004 (Audit 2026-09-23) hat das umgedreht. Dieser Test haelt den neuen
 * Vertrag als ZUSTAND fest, nicht als Dateizaehlung:
 *
 *   1. Jede angelegte Tabelle hat RLS aktiviert.
 *   2. `anon` darf SELECT ausschliesslich auf der Allow-Liste
 *      (BROWSER_ANON_TABLES) - nachgewiesen aus dem Browser-Code.
 *   3. Keine Policy fuer `authenticated` oder `public`.
 *   4. Jede Policy ist entweder `to service_role` oder durch
 *      `auth.role() = 'service_role'` geschuetzt.
 *   5. Jede Policy ist wiederholbar anwendbar (drop/guard vorhanden).
 *
 * Der Vertrag wird PRO MIGRATIONSSATZ geprueft, weil zur Laufzeit nur EINER
 * eingespielt wird, und danach ueber beide Saetze hinweg verglichen - die
 * Allow-Liste muss identisch sein (Migrations-Drift, Befund RC2-001).
 */

/** Einzige Tabellen, die der Browser mit dem anon-Key liest. */
const BROWSER_ANON_TABLES = ['samples', 'music_tracks'] as const;

/** Quelle der Allow-Liste (Nachweis, nicht Behauptung). */
const ALLOW_LIST_EVIDENCE = 'src/lib/supabaseClient.ts:73 (samples), :85 (music_tracks) - einzige anon-Leser im Browser';

/** reset.sql ist bewusst destruktiv und wird separat ausgefuehrt - nicht Teil des Vertrags. */
const EXCLUDED_FILES = new Set(['reset.sql']);

interface Policy {
  name: string;
  table: string;
  command: string;
  /** Aus `to <role>` ODER aus `auth.role() = '<role>'`; '' = keine Rollenangabe gefunden. */
  role: string;
}

/** Zeilen- und Blockkommentare entfernen, damit Auskommentiertes nicht zaehlt. */
function stripComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function createdTables(sql: string): string[] {
  return [...sql.matchAll(/create table if not exists\s+(?:public\.)?(\w+)/g)].map((m) => m[1]);
}

function rlsEnabledTables(sql: string): string[] {
  return [...sql.matchAll(/alter table\s+(?:public\.)?(\w+)\s+enable row level security/g)].map((m) => m[1]);
}

/**
 * Policies als Zustandsaenderungen lesen.
 * Zwei Schreibweisen kommen im Repo vor:
 *   create policy "name" on public.t for select to anon using (true);
 *   create policy name on public.t for all using (auth.role() = 'service_role') with check (...);
 * Beide werden erkannt; die Rolle kommt aus `to <role>` oder aus `auth.role()`.
 */
function policyStatements(sql: string): { kind: 'create' | 'drop'; policy: Policy | { name: string } }[] {
  const out: { kind: 'create' | 'drop'; policy: Policy | { name: string } }[] = [];
  for (const raw of sql.split(';')) {
    const chunk = raw.replace(/\s+/g, ' ').trim();
    const drop = /^drop policy if exists\s+"([^"]+)"|^drop policy if exists\s+(\w+)/.exec(chunk);
    if (drop) {
      out.push({ kind: 'drop', policy: { name: drop[1] ?? drop[2] } });
      continue;
    }
    const create = /^create policy\s+(?:"([^"]+)"|(\w+))\s+on\s+(?:public\.)?(\w+)\s+for\s+(\w+)/.exec(chunk);
    if (create) {
      const toRole = /\bto\s+(\w+)/.exec(chunk);
      const authRole = /auth\.role\(\)\s*=\s*'(\w+)'/.exec(chunk);
      out.push({
        kind: 'create',
        policy: {
          name: create[1] ?? create[2],
          table: create[3],
          command: create[4],
          role: (toRole?.[1] ?? authRole?.[1] ?? '').toLowerCase(),
        },
      });
    }
  }
  return out;
}

/** Endzustand eines Migrationssatzes: angelegte Tabellen, RLS-Tabellen, aktive Policies. */
function resolveState(files: string[]) {
  const tables = new Set<string>();
  const rls = new Set<string>();
  const policies = new Map<string, Policy>();
  const createdNames = new Set<string>();
  for (const file of files) {
    const sql = stripComments(readFileSync(file, 'utf8')).toLowerCase();
    createdTables(sql).forEach((t) => tables.add(t));
    rlsEnabledTables(sql).forEach((t) => rls.add(t));
    for (const stmt of policyStatements(sql)) {
      if (stmt.kind === 'drop') {
        policies.delete((stmt.policy as { name: string }).name);
      } else {
        const p = stmt.policy as Policy;
        policies.set(p.name, p);
        createdNames.add(p.name);
      }
    }
  }
  return { tables: [...tables], rls: [...rls], policies: [...policies.values()], createdNames: [...createdNames] };
}

/** anon-SELECT-Paare (Tabelle) im Endzustand. */
function anonSelectTables(state: { policies: Policy[] }): string[] {
  return state.policies
    .filter((p) => p.role === 'anon' && p.command === 'select')
    .map((p) => p.table)
    .sort();
}

const SETS: { label: string; files: string[] }[] = [
  {
    label: 'supabase/migrations (angewandt von scripts/apply-supabase-migrations.ts)',
    files: readdirSync(path.resolve(process.cwd(), 'supabase', 'migrations'))
      .filter((f) => f.endsWith('.sql') && !EXCLUDED_FILES.has(f))
      .sort()
      .map((f) => path.resolve(process.cwd(), 'supabase', 'migrations', f)),
  },
  {
    label: 'database (referenziert in Doku/Tests)',
    files: readdirSync(path.resolve(process.cwd(), 'database'))
      .filter((f) => f.endsWith('.sql') && !EXCLUDED_FILES.has(f))
      .sort()
      .map((f) => path.resolve(process.cwd(), 'database', f)),
  },
];

describe('GAP-4 / RC1-004 · Supabase-RLS: kein anon-Lesen ausserhalb der Browser-Allow-Liste', () => {
  for (const set of SETS) {
    describe(set.label, () => {
      const state = resolveState(set.files);

      it('findet ueberhaupt Migrationen', () => {
        expect(set.files.length).toBeGreaterThan(0);
        expect(state.tables.length).toBeGreaterThan(0);
      });

      it('aktiviert RLS fuer jede angelegte Tabelle', () => {
        const missing = state.tables.filter((t) => !state.rls.includes(t));
        expect(missing, `RLS fehlt fuer: ${missing.join(', ')}`).toEqual([]);
      });

      it(`gibt anon-SELECT nur auf der Allow-Liste (${BROWSER_ANON_TABLES.join(', ')})`, () => {
        const granted = anonSelectTables(state);
        const extra = granted.filter((t) => !BROWSER_ANON_TABLES.includes(t as (typeof BROWSER_ANON_TABLES)[number]));
        expect(
          extra,
          `anon-SELECT ausserhalb der Allow-Liste. Nachweis der Allow-Liste: ${ALLOW_LIST_EVIDENCE}`,
        ).toEqual([]);
      });

      it('vergibt keine Policies an authenticated/public-Rollen', () => {
        const bad = state.policies.filter((p) => ['authenticated', 'public', 'anon_user'].includes(p.role));
        expect(bad.map((p) => `${p.name}(${p.role})`)).toEqual([]);
      });

      it('schuetzt jede Nicht-anon-Policy auf service_role', () => {
        const unlocked = state.policies
          .filter((p) => p.role !== 'anon')
          .filter((p) => p.role !== 'service_role');
        expect(
          unlocked.map((p) => `${p.name}(role='${p.role}')`),
          'Policy ohne service_role-Bindung - entweder `to service_role` oder auth.role()-Guard',
        ).toEqual([]);
      });

      it('ist wiederholbar anwendbar (drop/guard je Policy)', () => {
        const unrepeatable = state.createdNames.filter((name) => {
          const pattern = new RegExp(`drop policy if exists\\s+"?${name}"?`, 'g');
          const guarded = new RegExp(`policyname\\s*=\\s*'${name}'`, 'g');
          return set.files.every((f) => {
            const sql = stripComments(readFileSync(f, 'utf8')).toLowerCase();
            return !pattern.test(sql) && !guarded.test(sql);
          });
        });
        expect(unrepeatable, `ohne drop/guard: ${unrepeatable.join(', ')}`).toEqual([]);
      });
    });
  }

  it('kein Satz vergibt mehr anon-Rechte als die Allow-Liste (Drift-Schutz RC2-001)', () => {
    // Bewusst KEINE Gleichheit beider Saetze: der angewandte Satz
    // (supabase/migrations) provisioniert `samples`/`music_tracks` gar nicht -
    // die liegen nur in database/schema.sql. Genau diese Unvollstaendigkeit ist
    // der Drift-Befund RC2-001. Der sicherheitsrelevante Vertrag lautet:
    // KEIN Satz vergibt anon ueber die Allow-Liste hinaus, und in der SUMME
    // beider Saetze ist die Allow-Liste vollstaendig abgedeckt.
    const perSet = SETS.map((s) => ({ label: s.label, anon: anonSelectTables(resolveState(s.files)) }));
    for (const entry of perSet) {
      const extra = entry.anon.filter((t) => !BROWSER_ANON_TABLES.includes(t as (typeof BROWSER_ANON_TABLES)[number]));
      expect(extra, `Satz "${entry.label}" vergibt anon auf: ${extra.join(', ')}`).toEqual([]);
    }
    const union = [...new Set(perSet.flatMap((e) => e.anon))].sort();
    expect(
      union,
      `In der Summe fehlt ein anon-Leserecht fuer den Browser. Nachweis: ${ALLOW_LIST_EVIDENCE}`,
    ).toEqual([...BROWSER_ANON_TABLES].sort());
  });

  it('NEGATIV: eine zusaetzliche anon-Policy wird wirklich erkannt (Gate ist keine Briefmarke)', () => {
    const synthetic = `
      create table if not exists public.ai_jobs (job_id text primary key);
      alter table public.ai_jobs enable row level security;
      create policy "anon_read_ai_jobs" on public.ai_jobs for select to anon using (true);
      create policy "service_write_ai_jobs" on public.ai_jobs for all to service_role using (true) with check (true);
    `;
    const sql = stripComments(synthetic).toLowerCase();
    const policies = policyStatements(sql)
      .filter((s) => s.kind === 'create')
      .map((s) => s.policy as Policy);
    const anon = policies.filter((p) => p.role === 'anon' && p.command === 'select').map((p) => p.table);
    expect(anon).toEqual(['ai_jobs']);
    expect(anon).not.toEqual([...BROWSER_ANON_TABLES].sort());
  });
});
