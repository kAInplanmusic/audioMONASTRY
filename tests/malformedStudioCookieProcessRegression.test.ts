import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Use a child so the pre-fix unhandled rejection cannot kill the test runner.
// A Unix socket and a disabled fetch keep the integration test off the network.
it('rejects malformed studio cookies without terminating the server process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-cookie-'));
  const socketPath = join(dir, 'server.sock');
  const master = 'cookie regression % master';
  const script = `
    globalThis.fetch = async () => { throw new Error('network disabled'); };
    const { app } = await import('./server.ts');
    const server = app.listen(process.env.TEST_SOCKET, () => process.send('ready'));
    process.on('message', (message) => { if (message === 'stop') server.close(() => process.exit(0)); });
  `;
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      TMPDIR: dir,
      NODE_ENV: 'test',
      VITEST: 'true',
      AUDIOMONASTRY_NO_AUTOSTART: '1',
      STUDIO_ACCESS_TOKEN: master,
      TEST_SOCKET: socketPath,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 4096); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
  });
  const get = (headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath, path: '/api/online', headers, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.end();
  });
  try {
    const startup = await Promise.race([ready.then(() => 'ready'), exited.then(() => 'exited')]);
    expect(startup, `child exited during startup: ${stderr}`).toBe('ready');
    expect((await get({ cookie: `studio=${encodeURIComponent(master)}` })).status).toBe(200);
    expect((await get({ cookie: 'studio=invalid' })).status).toBe(401);
    expect((await get({ 'x-studio-token': master, cookie: 'studio=%ZZ' })).status).toBe(200);
    for (const cookie of ['studio=%ZZ', 'studio=%E0%A4%A']) {
      const result = await Promise.race([
        get({ cookie }).then((response) => ({ kind: 'response' as const, response }), () => ({ kind: 'request-error' as const })),
        exited.then((exit) => ({ kind: 'exited' as const, exit })),
      ]);
      expect(result.kind, `server must respond without exiting; stderr: ${stderr}`).toBe('response');
      if (result.kind !== 'response') throw new Error('server did not respond');
      expect(result.response.status).toBe(401);
      expect(JSON.parse(result.response.body)).toMatchObject({ code: 'STUDIO_TOKEN_REQUIRED' });
      expect(child.exitCode).toBeNull();
    }
    expect((await get({ cookie: `studio=${encodeURIComponent(master)}` })).status).toBe(200);
    expect(child.exitCode).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
