/**
 * F5-Fix: /api/health darf nicht am Studio-Budget hängen.
 * =======================================================
 * Live belegt am 2026-09-20 an der externen Instanz: `/api/health` lag HINTER dem
 * allgemeinen /api-Limiter (60/min, Schlüssel = Master-Token). Ergebnis: 30
 * parallele Health-Aufrufe -> 300/300 HTTP 429, `Retry-After: 56`. Damit konnte
 * normaler Studio-Betrieb die Monitoring-/Alarmierungskette aussperren.
 *
 * Geprüft wird am echten Server:
 *   - > 100 Health-Aufrufe in einem Fenster bleiben 200 (Auflage: "überlebt
 *     > 100 Requests/Minute"),
 *   - das allgemeine /api-Budget bleibt davon UNBERÜHRT (eigene Zählung),
 *   - das Health-Limit ist großzügig (Default 600/min).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

let server: Server;
let baseUrl = '';

/** Auflage aus dem Auftrag: mehr als 100 Aufrufe pro Minute müssen durchgehen. */
const HEALTH_BURST = 130;

beforeAll(async () => {
  process.env.VITEST = 'true';
  process.env.NODE_ENV = 'test';
  delete process.env.STUDIO_ACCESS_TOKEN;
  // Kleines allgemeines Limit: waere Health noch darunter, waere der Burst 429.
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

describe('F5: eigener Health-Limiter', () => {
  it(`überlebt ${HEALTH_BURST} Aufrufe in einem Fenster (kein einziger 429)`, async () => {
    const statuses: number[] = [];
    for (let i = 0; i < HEALTH_BURST; i += 1) {
      const res = await fetch(`${baseUrl}/api/health`);
      statuses.push(res.status);
    }
    expect(new Set(statuses)).toEqual(new Set([200]));
    expect(statuses.length).toBeGreaterThan(100);
  });

  it('verbraucht das allgemeine /api-Budget nicht', async () => {
    // Der Burst oben hat das allgemeine Budget (2/min) nicht angetastet.
    expect((await fetch(`${baseUrl}/api/online`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/online`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/online`)).status).toBe(429);
    // …und Health antwortet weiterhin (eigener Zaehler).
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
  });

  it('nennt ein großzügiges Health-Limit (Default 600/min)', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    // express-rate-limit schreibt die Grenze je Version unterschiedlich benannt
    // (draft-6/draft-7); beide Namen werden akzeptiert.
    const limit = res.headers.get('ratelimit-limit') ?? res.headers.get('x-ratelimit-limit');
    expect(limit).toBe('600');
  });
});
