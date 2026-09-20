/**
 * F8 · Reset-Hook in PRODUKTION (echter Serverprozess, NODE_ENV=production)
 * ========================================================================
 * Der Test läuft mit `NODE_ENV=production` UND gesetztem Dev-Schalter
 * (`AUDIOMONASTRY_TEST_RESET=1`) UND gültigem Studio-Token. Genau diese
 * Kombination ist der interessante Fall: die Produktions-Schranke muss stärker
 * sein als der Schalter — sonst wäre ein versehentlich in der Flotten-`.env`
 * stehengebliebener Schalter ein offener Reset für jeden mit Token.
 *
 * Geprüft wird echtes HTTP gegen den Server aus server.ts:
 *   * POST /api/session/reset → 404 (mit Token und ohne)
 *   * GET  /api/session/state → 404 (kein Lese-Zugang, der die Existenz verrät)
 *   * GET  /api/health → 200 (Health bleibt offen, Regression der Prod-Auth)
 *
 * Die Schranke wird NICHT aus Textmustern geschlossen (Struktur-Guards können
 * nur Text prüfen) — hier antwortet der echte Handler.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.VITEST = 'true';
process.env.NODE_ENV = 'production';
process.env.AUDIOMONASTRY_TEST_RESET = '1';
process.env.STUDIO_ACCESS_TOKEN = 'f8-prod-token';

let server: Server;
let baseUrl = '';

// ARCH-PERF-001: eigener Hook-Timeout — der Import von server.ts braucht unter
// paralleler Vitest-Last mehr als die globalen 30 s (dieselbe Beobachtung wie in
// vitest.config.ts/aiRoutes besprochen). 120 s, damit ein langsamer Rechner nicht
// als Fehler erscheint.
beforeAll(async () => {
  const mod = await import('../server');
  server = await new Promise<Server>((resolve) => {
    const started = mod.app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Env-Leak verhindern (dieselbe Vorsicht wie tests/securityProductionAuth.test.ts):
  // im selben Vitest-Worker dürfen die folgenden Dateien nicht im Produktionsmodus
  // oder mit gesetztem Reset-Schalter laufen.
  process.env.NODE_ENV = 'test';
  delete process.env.AUDIOMONASTRY_TEST_RESET;
  delete process.env.STUDIO_ACCESS_TOKEN;
});

describe('F8: Reset-Hook in Produktion bleibt fail-closed', () => {
  it('POST /api/session/reset → 404, auch mit Token und gesetztem Schalter', async () => {
    const withToken = await fetch(`${baseUrl}/api/session/reset`, {
      method: 'POST',
      headers: { 'x-studio-token': 'f8-prod-token' },
    });
    expect(withToken.status).toBe(404);
    expect(await withToken.text()).toBe('');
  });

  it('POST /api/session/reset ohne Token → 401 der allgemeinen Auth (kein Existenz-Hinweis)', async () => {
    // Die Produktions-Auth greift VOR der Route: ohne Token antwortet die
    // allgemeine /api-Schranke mit 401 — dieselbe Antwort wie fuer jede andere
    // unbekannte Route. Ob der Hook existiert, verraet der Server damit nicht.
    const res = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('GET /api/session/state → 404 (kein Lese-Zugang zum Serverzustand)', async () => {
    const res = await fetch(`${baseUrl}/api/session/state`, { headers: { 'x-studio-token': 'f8-prod-token' } });
    expect(res.status).toBe(404);
  });

  it('GET /api/health bleibt offen (Regression der Produktions-Auth)', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });
});
