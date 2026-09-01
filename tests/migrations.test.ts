import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('P3-1: Migration 002 (idempotent)', () => {
  const sql = readFileSync(path.resolve(process.cwd(), 'database/ai_migration_002.sql'), 'utf8');

  it('erstellt alle vier Tabellen idempotent', () => {
    for (const table of ['system_prompts', 'plugin_prompt_versions', 'ai_evaluations', 'ai_eval_runs']) {
      expect(sql).toContain(`create table if not exists public.${table}`);
    }
  });

  it('Versionseintrag ist idempotent (on conflict do nothing)', () => {
    expect(sql).toContain("insert into public.ai_migrations (version, description)");
    expect(sql).toContain('on conflict (version) do nothing');
  });

  it('RLS-Policies sind wiederholbar (drop policy if exists)', () => {
    expect(sql.match(/drop policy if exists/g)?.length).toBeGreaterThanOrEqual(8);
    expect(sql).toContain('create policy "anon_read_system_prompts"');
    expect(sql).toContain('create policy "service_write_ai_eval_runs"');
  });
});
