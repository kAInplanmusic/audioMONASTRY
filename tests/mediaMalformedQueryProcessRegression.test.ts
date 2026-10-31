import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('rejects malformed duplicate query tokens without terminating the media server', async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR || '/opt/data/cache/scratch', 'media-query-'));
  const socketPath = join(dir, 'server.sock');
  const master = 'local media test token/with space';
  await mkdir(join(dir, 'dist', 'music'), { recursive: true });
  await writeFile(join(dir, 'dist', 'music', 'fixture.mp3'), 'media-fixture');
  const script = `
    globalThis.fetch = async () => { throw new Error('network disabled'); };
    const http = (await import('node:http')).default;
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (_port, _host, callback) {
      return listen.call(this, process.env.TEST_SOCKET, callback);
    };
    const { startServer } = await import('./server.ts');
    process.chdir(process.env.TEST_HOME);
    await startServer(0);
    process.send('ready');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NODE_ENV: 'production', VITEST: 'true', AUDIOMONASTRY_NO_AUTOSTART: '1', SESSION_STATE_FILE: 'off', REDIS_URL: '', ENABLE_SFU: '0', STUDIO_ACCESS_TOKEN: master, TEST_SOCKET: socketPath, TEST_HOME: dir },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk).slice(0, 4096); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); });
  const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath, path, headers, timeout: 5000 }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('request timed out'))); req.end();
  });
  try {
    expect(await Promise.race([ready.then(() => 'ready'), exited.then(() => 'exited')]), stderr).toBe('ready');
    const path = '/music/fixture.mp3?token=%ZZ&token=x';
    const result = await Promise.race([
      get(path).then(response => ({ kind: 'response', response }), () => ({ kind: 'request-error', response: null })),
      exited.then(() => ({ kind: 'exited', response: null })),
    ]);
    expect(result.kind, `media process must respond without exiting: ${stderr}`).toBe('response');
    expect(result.response?.status).toBe(401);
    expect(JSON.parse(result.response!.body)).toMatchObject({ code: 'STUDIO_TOKEN_REQUIRED' });
    expect((await get('/music/fixture.mp3')).status).toBe(401);
    expect(await get(path, { 'x-studio-token': master })).toMatchObject({ status: 200, body: 'media-fixture' });
    expect(await get(`/music/fixture.mp3?token=${encodeURIComponent(master)}`)).toMatchObject({ status: 200, body: 'media-fixture' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
