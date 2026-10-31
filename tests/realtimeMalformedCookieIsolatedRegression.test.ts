import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Exercise the real Socket.IO middleware in a separate process over a Unix socket.
it('rejects malformed cookie handshakes without killing signaling or overriding other credentials', async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR || '/opt/data/cache/scratch', 'signaling-cookie-'));
  const socketPath = join(dir, 'server.sock');
  const master = 'local test token/with space';
  const script = `
    globalThis.fetch = async () => { throw new Error('network disabled'); };
    const http = (await import('node:http')).default;
    const { createRealtimeHub } = await import('./server/realtime.ts');
    const { createSessionRuntime } = await import('./server/sessionRuntime.ts');
    const runtime = createSessionRuntime({ log: () => {} });
    const server = http.createServer((_req, res) => res.end('alive'));
    await createRealtimeHub(server, {
      sessionRuntime: runtime, addServerAudit: () => {}, resolveSessionMainOutUserId: () => '',
      pluginLockTtlMs: 60000, studioTokenMissing: false, studioAuthOpen: false,
      studioAccessToken: process.env.TEST_MASTER, studioSessionSecret: '',
      safeTokenEqual: (a, b) => a === b, looksLikeStudioSession: () => false,
      verifyStudioSession: async () => false, log: () => {}, warn: () => {},
    });
    server.listen(process.env.TEST_SOCKET, () => process.send('ready'));
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NODE_ENV: 'test', SESSION_STATE_FILE: 'off', REDIS_URL: '', ENABLE_SFU: '0', TEST_SOCKET: socketPath, TEST_MASTER: master },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk).slice(0, 4096); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); });
  const req = (path: string, method = 'GET', headers: Record<string, string> = {}, body = '') => new Promise<string>((resolve, reject) => {
    const request = http.request({ socketPath, path, method, headers, timeout: 4000 }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve(data));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('request timed out'))); request.end(body);
  });
  const handshake = async (cookie: string, auth: object = {}, extra: Record<string, string> = {}) => {
    const path = '/webrtc-signaling/?EIO=4&transport=polling';
    const open = await req(path, 'GET', { cookie, ...extra });
    const sid = JSON.parse(open.slice(1)).sid;
    await req(`${path}&sid=${sid}`, 'POST', { 'content-type': 'text/plain' }, `40${JSON.stringify(auth)}`);
    return req(`${path}&sid=${sid}`);
  };
  try {
    expect(await Promise.race([ready.then(() => 'ready'), exited.then(() => 'exited')]), stderr).toBe('ready');
    expect(await handshake(`studio=${encodeURIComponent(master)}`)).toMatch(/^40/);
    expect(await handshake('studio=%ZZ', { token: master })).toMatch(/^40/);
    expect(await handshake('studio=%ZZ', {}, { 'x-studio-token': master })).toMatch(/^40/);
    for (const cookie of ['studio=%ZZ', 'studio=%E0%A4%A']) {
      const result = await Promise.race([
        handshake(cookie).then(data => ({ kind: 'response', data }), () => ({ kind: 'request-error', data: '' })),
        exited.then(() => ({ kind: 'exited', data: '' })),
      ]);
      expect(result.kind, `signaling process must respond without exiting: ${stderr}`).toBe('response');
      expect(result.data).toContain('unauthorized');
      expect(await req('/health')).toBe('alive');
    }
    expect(await handshake(`studio=${encodeURIComponent(master)}`)).toMatch(/^40/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
