import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signStudioSession } from '../src/core/session/studioSession';

/**
 * SEC-P2-002 – Ende-zu-Ende: Der Server akzeptiert den Master-Token UND das
 * kurzlebige signierte Session-Token des Portals (Header **und** Cookie),
 * lehnt aber gefälschte, abgelaufene und fremd-signierte Token ab.
 *
 * Der Server wird echt gestartet (wie in tests/securityProductionAuth.test.ts);
 * die Env-Variablen müssen VOR dem Import gesetzt sein.
 */
process.env.VITEST = 'true';
process.env.NODE_ENV = 'production';
const MASTER = 'test-master-token-sec-p2-002';
const SECRET = 'test-session-secret-sec-p2-002';
process.env.STUDIO_ACCESS_TOKEN = MASTER;
process.env.SESSION_SECRET = SECRET;

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const mod = await import('../server');
  server = mod.app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.STUDIO_ACCESS_TOKEN;
  delete process.env.SESSION_SECRET;
});

const get = (headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/api/online`, { headers });

describe('Studio-Auth: Master-Token und Session-Token', () => {
  it('akzeptiert den Master-Token weiterhin (Rückwärtskompatibilität für Skripte/CI)', async () => {
    const res = await get({ 'x-studio-token': MASTER });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('online');
  });

  it('akzeptiert ein gültiges Session-Token im Header', async () => {
    const token = await signStudioSession(SECRET, { ttlS: 60 });
    const res = await get({ 'x-studio-token': token });
    expect(res.status).toBe(200);
  });

  it('akzeptiert ein gültiges Session-Token im studio-Cookie (Portal-Weg)', async () => {
    const token = await signStudioSession(SECRET, { ttlS: 60 });
    const res = await get({ cookie: `studio=${encodeURIComponent(token)}` });
    expect(res.status).toBe(200);
  });

  it('lehnt ein abgelaufenes Session-Token ab (401)', async () => {
    const expired = await signStudioSession(SECRET, { nowSec: Math.floor(Date.now() / 1000) - 3600, ttlS: 60 });
    const res = await get({ 'x-studio-token': expired });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'STUDIO_TOKEN_REQUIRED' });
  });

  it('lehnt ein manipuliertes Session-Token ab (401)', async () => {
    const token = await signStudioSession(SECRET, { ttlS: 60 });
    const [, exp, sig] = token.split('.');
    const flipped = sig.replace(sig[0], sig[0] === 'a' ? 'b' : 'a');
    const res = await get({ 'x-studio-token': `v1.${exp}.${flipped}` });
    expect(res.status).toBe(401);
  });

  it('lehnt ein mit fremdem Secret signiertes Token ab (401)', async () => {
    const foreign = await signStudioSession('anderes-secret', { ttlS: 60 });
    const res = await get({ 'x-studio-token': foreign });
    expect(res.status).toBe(401);
  });

  it('lehnt Anfragen ohne Token ab (401)', async () => {
    const res = await get();
    expect(res.status).toBe(401);
  });
});
