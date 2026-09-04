import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * GAP-4 · Supabase-RLS-Audit (statisch)
 * =====================================
 * Regressions-Gate für alle SQL-Dateien in `database/`: Jede angelegte Tabelle
 * muss Row Level Security aktiviert haben, `anon` darf ausschließlich lesen und
 * Schreibrechte gibt es nur für `service_role`. Der Test ist rein statisch – er
 * braucht keine Supabase-Verbindung und läuft damit auch in der CI.
 */
const SQL_FILES = ['schema.sql', 'ai_migration_001.sql', 'ai_migration_002.sql'];

function readSql(file: string): string {
  const raw = readFileSync(path.resolve(process.cwd(), 'database', file), 'utf8').toLowerCase();
  // Kommentarzeilen entfernen, damit auskommentierte Statements nicht als
  // vorhanden gewertet werden.
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function createdTables(sql: string): string[] {
  return [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
}

/** Policy-Definitionen: `create policy "<name>" on public.<table> for <cmd> to <role>`. */
function policies(sql: string): { table: string; command: string; role: string }[] {
  const re = /create policy\s+"[^"]+"\s+on public\.(\w+)\s+for\s+(\w+)\s+to\s+(\w+)/g;
  return [...sql.matchAll(re)].map((m) => ({ table: m[1], command: m[2], role: m[3] }));
}

describe('GAP-4 · Supabase RLS: anon liest, service_role schreibt', () => {
  for (const file of SQL_FILES) {
    describe(file, () => {
      const sql = readSql(file);
      const tables = createdTables(sql);
      const defined = policies(sql);

      it('legt mindestens eine Tabelle an', () => {
        expect(tables.length).toBeGreaterThan(0);
      });

      it('aktiviert RLS für jede angelegte Tabelle', () => {
        for (const table of tables) {
          expect(sql).toContain(`alter table public.${table} enable row level security`);
        }
      });

      it('gibt jeder Tabelle genau eine anon-SELECT-Policy', () => {
        for (const table of tables) {
          const anon = defined.filter((p) => p.table === table && p.role === 'anon');
          expect(anon.length, `anon-Policy fehlt für ${table}`).toBe(1);
          expect(anon[0].command, `anon darf bei ${table} nur lesen`).toBe('select');
        }
      });

      it('erlaubt Schreibzugriff ausschließlich für service_role', () => {
        for (const table of tables) {
          const write = defined.filter((p) => p.table === table && p.command !== 'select');
          expect(write.length, `Schreib-Policy fehlt für ${table}`).toBeGreaterThan(0);
          for (const policy of write) {
            expect(policy.role, `Schreibrecht auf ${table} nur für service_role`).toBe('service_role');
          }
        }
      });

      it('vergibt keine Policies an authenticated/public-Rollen', () => {
        for (const policy of defined) {
          expect(['anon', 'service_role']).toContain(policy.role);
        }
      });

      it('ist wiederholbar anwendbar (drop policy if exists je Policy)', () => {
        const drops = sql.match(/drop policy if exists/g)?.length ?? 0;
        expect(drops).toBeGreaterThanOrEqual(defined.length);
      });
    });
  }
});
