/**
 * F5-Fix: Rate-Limit-Identität je Nutzer/Session statt je Master-Token.
 * =====================================================================
 * Vorher war der Schlüssel der Studio-Token selbst (`studioKeyGenerator`) – und
 * das ist bei allen Beteiligten derselbe Master-Token. Live belegt am 2026-09-20
 * an der externen Instanz: 75 sequenzielle Aufrufe -> exakt 60×200 + 15×429
 * (`Retry-After: 56`), d. h. ein Client konnte allen anderen das Budget nehmen.
 *
 * Geprüft wird hier am echten HTTP-Server (kleines Limit von 2/min):
 *   1. Zwei unterschiedliche `x-session-id` (Kollaborations-UserId) -> getrennte Budgets.
 *   2. Zwei unterschiedliche signierte Session-Token (`v1.<exp>.<sub>.<sig>`) -> getrennte Budgets.
 *   3. Der Master-Token ist KEIN Schlüssel mehr: zwei VERSCHIEDENE Master-Token-Werte
 *      teilen sich weiterhin das IP-Budget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

let server: Server;
let baseUrl = '';

const MASTER_A = 'master-token-aaaa';
const MASTER_B = 'master-token-bbbb';
/** Formgültige Session-Token (`v1.<exp>.<sub>.<hmac>`); die Signatur prüft der Auth-Guard. */
const SESSION_A = `v1.9999999999.user-aaaa.${'a'.repeat(64)}`;
const SESSION_B = `v1.9999999999.user-bbbb.${'b'.repeat(64)}`;
/** Dieselbe exp, KEIN sub: die Token unterscheiden sich nur in der Signatur. */
const SESSION_NO_SUB_A = `v1.9999999999.${'c'.repeat(64)}`;
const SESSION_NO_SUB_B = `v1.9999999999.${'d'.repeat(64)}`;

/** Probe-Route unter dem allgemeinen /api-Limiter (klein, kein AI-/Cloud-Aufruf). */
const PROBE = '/api/online';

async function probe(headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(`${baseUrl}${PROBE}`, { headers });
  return res.status;
}

beforeAll(async () => {
  process.env.VITEST = 'true';
  process.env.NODE_ENV = 'test';
  // Offener Test-Modus: die Auth lässt durch, geprüft wird nur der Limiter.
  delete process.env.STUDIO_ACCESS_TOKEN;
  process.env.API_RATE_LIMIT_MAX = '2';
  process.env.API_RATE_LIMIT_WINDOW_MS = String(60 * 1000);
  const mod = await import('../server');
  server = mod.app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('F5: Limiter-Schlüssel je Nutzer/Session', () => {
  it('zwei Kollaborations-UserIds (x-session-id) haben getrennte Budgets', async () => {
    const a = { 'x-studio-token': MASTER_A, 'x-session-id': 'user-aaaa' };
    const b = { 'x-studio-token': MASTER_A, 'x-session-id': 'user-bbbb' };
    expect(await probe(a)).toBe(200);
    expect(await probe(a)).toBe(200);
    // Budget von A ist erschöpft – der dritte Aufruf trifft das Limit.
    expect(await probe(a)).toBe(429);
    // B hat davon nichts verbraucht (vorher: EIN gemeinsames Budget fuer alle).
    expect(await probe(b)).toBe(200);
    expect(await probe(b)).toBe(200);
    expect(await probe(b)).toBe(429);
  });

  it('zwei signierte Session-Token (unterschiedliches sub) haben getrennte Budgets', async () => {
    const a = { 'x-studio-token': SESSION_A };
    const b = { 'x-studio-token': SESSION_B };
    expect(await probe(a)).toBe(200);
    expect(await probe(a)).toBe(200);
    expect(await probe(a)).toBe(429);
    expect(await probe(b)).toBe(200);
  });

  it('Session-Token ohne sub trennen ebenfalls (Token-Hash als Identität)', async () => {
    const a = { 'x-studio-token': SESSION_NO_SUB_A };
    const b = { 'x-studio-token': SESSION_NO_SUB_B };
    expect(await probe(a)).toBe(200);
    expect(await probe(a)).toBe(200);
    expect(await probe(a)).toBe(429);
    expect(await probe(b)).toBe(200);
  });

  it('der Master-Token ist kein Schlüssel mehr (IP-Fallback greift)', async () => {
    const a = { 'x-studio-token': MASTER_A };
    const b = { 'x-studio-token': MASTER_B };
    expect(await probe(a)).toBe(200);
    expect(await probe(a)).toBe(200);
    expect(await probe(a)).toBe(429);
    // Wäre der Token der Schluessel, haette MASTER_B ein frisches Budget (200).
    expect(await probe(b)).toBe(429);
  });

  it('ungültiges x-session-id wird ignoriert (Fallback IP, kein Sonderschlüssel)', async () => {
    // Zu kurz/außerhalb des erlaubten Zeichenvorrats -> Kennzeichen verworfen.
    const bad = { 'x-studio-token': MASTER_A, 'x-session-id': 'ab' };
    expect(await probe(bad)).toBe(429);
  });
});
