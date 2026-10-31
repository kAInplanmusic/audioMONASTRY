import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

// Import the real server in a fresh process for each auth configuration.
async function auditInMode(env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'audit-mode-'));
  const socketPath = join(dir, 'server.sock');
  const script = `
    globalThis.fetch = async () => { throw new Error('outbound network disabled'); };
    const { app } = await import('./server.ts');
    app.listen(process.env.TEST_SOCKET, () => process.send('ready'));
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, AUDIOMONASTRY_NO_AUTOSTART: '1', TEST_SOCKET: socketPath, ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 4096); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`server exited during startup: ${stderr}`)));
  });
  try {
    await ready;
    return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request({ socketPath, path: '/api/audit', timeout: 5000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('request timed out')));
      req.end();
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
}

it('keeps audit available in the explicit no-auth development mode', async () => {
  const result = await auditInMode({ NODE_ENV: 'development', AUDIOMONASTRY_DEV_NO_AUTH: '1' });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ entries: expect.any(Array), total: expect.any(Number) });
}, 120_000);

it('keeps audit available in test mode without a token', async () => {
  const result = await auditInMode({ NODE_ENV: 'test', VITEST: 'true' });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ entries: expect.any(Array), total: expect.any(Number) });
}, 120_000);

it('does not open development mode without an explicit override', async () => {
  const result = await auditInMode({ NODE_ENV: 'development' });
  expect(result.status).toBe(503);
  expect(result.body).toMatchObject({ code: 'STUDIO_TOKEN_MISSING' });
}, 120_000);

it('does not bypass a configured token even with the development override', async () => {
  const result = await auditInMode({ NODE_ENV: 'development', AUDIOMONASTRY_DEV_NO_AUTH: '1', STUDIO_ACCESS_TOKEN: 'audit-dev-master' });
  expect(result.status).toBe(401);
  expect(result.body).toMatchObject({ code: 'STUDIO_TOKEN_REQUIRED' });
}, 120_000);

it('does not allow the development override in production without a token', async () => {
  const result = await auditInMode({ NODE_ENV: 'production', AUDIOMONASTRY_DEV_NO_AUTH: '1', VITEST: 'true' });
  expect(result.status).toBe(503);
  expect(result.body).toMatchObject({ code: 'STUDIO_TOKEN_MISSING' });
}, 120_000);
