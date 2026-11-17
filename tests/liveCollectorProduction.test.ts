import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
it('production entry fails closed before CDP without actual costs despite local-staging env flag', async () => {
  const output = mkdtempSync(join(tmpdir(), 'production-cost-'));
  const child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise<string | null>(r => child.once('exit', (_code, signal) => r(signal)));
  await new Promise<void>(r => child.stdout.once('data', () => r()));
  try {
    const collector = spawn(process.execPath, ['--import', 'tsx', 'scripts/audit/live-browser.ts'], {
      env: { ...process.env, LIVE_AUDIT_MODE: 'local-staging', LIVE_AUDIT_CDP: 'http://127.0.0.1:1',
        LIVE_AUDIT_ORIGIN: 'http://127.0.0.1:1', LIVE_AUDIT_SFU_HEALTH: 'http://127.0.0.1:1/health',
        LIVE_AUDIT_OUTPUT: output, LIVE_AUDIT_SESSION_ID: 'production-no-cost', LIVE_AUDIT_SESSION_PID: String(child.pid),
        LIVE_AUDIT_COST_API: '', LIVE_AUDIT_COST_TOKEN: '' }, stdio: 'ignore' });
    const code = await new Promise<number | null>(r => collector.once('exit', r));
    expect(code).toBe(1); expect(await stopped).toBe('SIGTERM');
    const rows = readFileSync(join(output, 'raw.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0].simulationCosts).toBe(false);
    expect(rows.find(r => r.type === 'guard-stop').reason).toBe('cost-unavailable-or-invalid');
    expect(rows.some(r => r.type === 'raw-snapshot')).toBe(false);
    const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
    expect(summary.signalSent).toBe(true);
    expect(JSON.parse(readFileSync(join(output, 'checkpoint.json'), 'utf8')).records).toBe(rows.length);
  } finally { child.kill('SIGTERM'); rmSync(output, { recursive: true, force: true }); }
}, 15000);

it('approved rate bound handles unavailable billing, then still stops on actual unhealthy origin', async () => {
  const output = mkdtempSync(join(tmpdir(), 'production-cost-'));
  const child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise<string | null>(r => child.once('exit', (_code, signal) => r(signal)));
  await new Promise<void>(r => child.stdout.once('data', () => r()));
  try {
    const collector = spawn(process.execPath, ['--import', 'tsx', 'scripts/audit/live-browser.ts'], {
      env: { ...process.env, LIVE_AUDIT_MODE: 'local-staging', LIVE_AUDIT_CDP: 'http://127.0.0.1:1',
        LIVE_AUDIT_ORIGIN: 'http://127.0.0.1:1', LIVE_AUDIT_SFU_HEALTH: 'http://127.0.0.1:1/health',
        LIVE_AUDIT_OUTPUT: output, LIVE_AUDIT_SESSION_ID: 'production-no-cost', LIVE_AUDIT_SESSION_PID: String(child.pid),
        LIVE_AUDIT_COST_API: 'https://127.0.0.1:1/unavailable', LIVE_AUDIT_COST_TOKEN: '', LIVE_AUDIT_RATE_BOUND: 'deploy/live-audit-cost-bound.json' }, stdio: 'ignore' });
    const code = await new Promise<number | null>(r => collector.once('exit', r));
    expect(code).toBe(1); expect(await stopped).toBe('SIGTERM');
    const rows = readFileSync(join(output, 'raw.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0].simulationCosts).toBe(false);
    expect(rows.find(r => r.type === 'cost-source').fallback).toBe('approved-rate-upper-bound');
    expect(rows.find(r => r.type === 'cost-upper-bound')).toMatchObject({ rEchtEurPerHour: .374612, rGuardEurPerHour: .561918, label: 'Obergrenze (R_guard), keine Ist-Kosten' });
    expect(rows.find(r => r.type === 'guard-stop').reason).toBe('origin-or-sfu-unhealthy');
    expect(rows.some(r => r.type === 'raw-snapshot')).toBe(false);
    const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
    expect(summary.signalSent).toBe(true);
    expect(JSON.parse(readFileSync(join(output, 'checkpoint.json'), 'utf8')).records).toBe(rows.length);
  } finally { child.kill('SIGTERM'); rmSync(output, { recursive: true, force: true }); }
}, 15000);
