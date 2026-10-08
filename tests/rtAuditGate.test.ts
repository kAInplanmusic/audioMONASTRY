// @vitest-environment node
/**
 * RT-AUDIT-P2-022: Der Echtzeit-Audit als CI-Gate.
 * =================================================
 * `npm run audit:rt:gate` bricht mit Exit 1 ab, sobald eine Grenze verletzt ist,
 * und läuft in `npm run verify` (und damit in der CI). `--only=ID,…` macht
 * einzelne Grenzen iterierbar.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/audit/rt-bench.ts');

function run(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT, ...args], { encoding: 'utf8', timeout: 120000 });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: typeof err.status === 'number' ? err.status : 1, stdout: String(err.stdout ?? '') };
  }
}

describe('RT-AUDIT-P2-022 · audit:rt als Gate', () => {
  it('--only beschränkt die Tabelle auf die gewählten Grenzen', () => {
    const r = run(['--only=RT-AUDIT-P0-001']);
    expect(r.stdout).toContain('RT-AUDIT-P0-001');
    expect(r.stdout).not.toContain('RT-AUDIT-P1-009');
    expect(r.stdout).toContain('1/1 Grenzen eingehalten');
    expect(r.status).toBe(0);
  });

  it('--gate beendet sich bei erfüllten Grenzen mit 0', () => {
    const r = run(['--gate', '--only=RT-AUDIT-P0-001']);
    expect(r.status).toBe(0);
  });
});
