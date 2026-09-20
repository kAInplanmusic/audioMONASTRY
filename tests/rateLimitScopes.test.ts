/**
 * F5-Fix: Die EIGENEN Budgets bleiben eigene Budgets.
 * ===================================================
 * Der allgemeine /api-Limiter hängt jetzt an der Nutzer-/Session-Identität
 * (server/rateLimitKeys.ts) und /api/health ist aus ihm herausgenommen. Genau
 * dieser Umbau ist die Gefahrenstelle für die Ausnahmen, die schon vorher
 * bestanden haben (FEAT-P3-003 Chunk-Upload, AI-P1-006 Agent-Läufe) und für den
 * neuen CSP-Meldeweg: eine zu weit gefasste `skip`-Regel oder ein falsch
 * verortetes `app.use` nimmt einer Route ihr Budget oder hängt sie doch wieder
 * unter das allgemeine Limit.
 *
 * Deshalb wird hier am echten Server mit ABSICHT winzigen Budgets gemessen und
 * die Zuordnung Route -> Limiter bewiesen:
 *   * allgemeiner Limiter:                 1/min
 *   * Agent-Läufe (eigenes Budget):        2/min, getrennt je Session-Identität
 *   * Chunk-Upload (eigenes Budget):       2/min
 *   * Health (eigenes, großzügiges):      Default (600/min)
 *
 * (Das eigene Budget des CSP-Meldewegs prüft tests/cspPolicy.test.ts, wo der
 * Endpunkt selbst Gegenstand ist.)
 *
 * Läge eine der Routen unter dem allgemeinen Limiter (1/min), wäre der zweite
 * Aufruf bereits 429 – die Erwartungen unten unterscheiden das eindeutig.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

let server: Server;
let baseUrl = '';

/** Identität A/B wie im echten Betrieb (Kollaborations-UserId je Browser). */
const SESSION_A = { 'x-session-id': 'user-scope-aaaa' };
const SESSION_B = { 'x-session-id': 'user-scope-bbbb' };

async function call(path: string, init: RequestInit = {}): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, init);
  return res.status;
}

beforeAll(async () => {
  process.env.VITEST = 'true';
  process.env.NODE_ENV = 'test';
  // Offener Test-Modus: die Auth lässt durch, geprüft werden nur die Limiter.
  delete process.env.STUDIO_ACCESS_TOKEN;
  process.env.API_RATE_LIMIT_MAX = '1';
  process.env.API_RATE_LIMIT_WINDOW_MS = String(60 * 1000);
  process.env.AI_AGENT_RATE_LIMIT_MAX = '2';
  process.env.UPLOAD_CHUNK_RATE_LIMIT_MAX = '2';
  const mod = await import('../server');
  server = mod.app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('F5: Budget-Grenzen nach der Identitäts-Umstellung', () => {
  it('Agent-Statusabfragen behalten ihr eigenes Budget (2/min je Session)', async () => {
    const get = (headers: Record<string, string>) => call('/api/ai/agent/runs', { headers });
    expect(await get(SESSION_A)).toBe(200);
    expect(await get(SESSION_A)).toBe(200);
    // Eigenes Budget erschöpft – NICHT das allgemeine (das wäre schon nach 1).
    expect(await get(SESSION_A)).toBe(429);
    // Und die zweite Session hat davon nichts verbraucht.
    expect(await get(SESSION_B)).toBe(200);
  });

  it('Chunk-Upload behält sein eigenes Budget (2/min)', async () => {
    // Ohne vorheriges /init gibt es die Sitzung nicht -> 404 aus der Route.
    // Entscheidend ist: 404 (Limiter greift nicht), nicht 429 (erneut gebremst).
    const put = (headers: Record<string, string>, index: number) =>
      call(`/api/upload/chunk/nicht-vorhanden/${index}`, { method: 'PUT', headers });
    expect(await put(SESSION_A, 0)).not.toBe(429);
    expect(await put(SESSION_A, 1)).not.toBe(429);
    expect(await put(SESSION_A, 2)).toBe(429);
  });

  it('Health bleibt außerhalb des allgemeinen Budgets (1/min) und liefert weiter 200', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push(await call('/api/health'));
    expect(new Set(statuses)).toEqual(new Set([200]));
  });
});
