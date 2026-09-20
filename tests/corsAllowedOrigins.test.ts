/**
 * F7-Fix: Origin-Allowlist der Produktion (kein `*`) und ihr Nachweis.
 * ===================================================================
 * Befund am 2026-09-20 (externe Instanz): der Portal-Worker schrieb
 * `SIGNALING_ALLOWED_ORIGINS=*` in die Knoten-.env. Damit war der
 * Origin-Schutz des Servers AUS (server.ts prüft die Liste nur, wenn sie kein
 * `*` enthält) – live gemessen:
 *   curl -H "Origin: https://evil.example" http://<app>/api/health  -> 200
 *
 * Diese Datei prüft die Kette vollständig, also Ableitung UND Wirkung:
 *   1. `signalingAllowedOrigins()` (Portal-Worker) erzeugt aus `APP_DOMAIN` die
 *      Produktions-Domain + lokale Test-Origins und NIE ein `*`; ein
 *      ausdrücklich gesetzter Wert wird übernommen, `*` nicht.
 *   2. Mit genau dieser Liste als einziger Origin-Konfiguration weist der
 *      Server eine fremde Origin mit `origin-not-allowed` (HTTP 403) ab und
 *      lässt Produktions-Domain und lokale Test-Origin durch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signalingAllowedOrigins } from '../services/portal-worker/src/index.js';

const PROD_DOMAIN = 'anunnakitools.de';
const LOCAL_TEST_ORIGIN = 'http://localhost:5173';
const FOREIGN = 'https://evil.example';

describe('F7: Ableitung der erlaubten Origins im Portal-Worker', () => {
  it('setzt die Produktions-Domain plus lokale Test-Origins – nie `*`', () => {
    const list = signalingAllowedOrigins({ APP_DOMAIN: PROD_DOMAIN }).split(',');
    expect(list).not.toContain('*');
    expect(list).toContain(`https://${PROD_DOMAIN}`);
    expect(list).toContain(LOCAL_TEST_ORIGIN);
    expect(list).toContain('http://127.0.0.1:5173');
    expect(list).toContain('http://localhost:4173');
  });

  it('übernimmt einen ausdrücklich gesetzten Wert – aber nicht die Wildcard', () => {
    expect(signalingAllowedOrigins({ SIGNALING_ALLOWED_ORIGINS: 'https://nur-das.example' }))
      .toBe('https://nur-das.example');
    // Genau der Befund: `*` darf NICHT durchgereicht werden.
    const ersatz = signalingAllowedOrigins({ SIGNALING_ALLOWED_ORIGINS: '*', APP_DOMAIN: PROD_DOMAIN });
    expect(ersatz).not.toContain('*');
    expect(ersatz).toContain(`https://${PROD_DOMAIN}`);
  });

  it('übernimmt eine abweichende Installations-Domain (und ergänzt www)', () => {
    const list = signalingAllowedOrigins({ APP_DOMAIN: 'https://kunde.example' }).split(',');
    expect(list).toContain('https://kunde.example');
    expect(list).toContain('https://www.kunde.example');
  });
});

describe('F7: Wirkung im Produktionsserver (Rest-API)', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    process.env.VITEST = 'true';
    process.env.STUDIO_ACCESS_TOKEN = 'test-studio-token';
    // Produktionskonfiguration: NUR die vom Portal-Worker erzeugte Liste ist
    // gesetzt (server.ts nutzt `SIGNALING_ALLOWED_ORIGINS` als Rückfall, wenn
    // `API_ALLOWED_ORIGINS` fehlt) – genau wie auf den Flottenknoten.
    delete process.env.API_ALLOWED_ORIGINS;
    process.env.SIGNALING_ALLOWED_ORIGINS = signalingAllowedOrigins({ APP_DOMAIN: PROD_DOMAIN });
    process.env.API_RATE_LIMIT_MAX = '1000';
    const mod = await import('../server');
    server = mod.app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('kein Port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.SIGNALING_ALLOWED_ORIGINS;
    delete process.env.STUDIO_ACCESS_TOKEN;
  });

  it('lässt die Produktions-Domain durch', async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { origin: `https://${PROD_DOMAIN}` } });
    expect(res.status).toBe(200);
  });

  it('lässt die lokale Test-Origin durch (Vite dev)', async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { origin: LOCAL_TEST_ORIGIN } });
    expect(res.status).toBe(200);
  });

  it('weist eine fremde Origin mit `origin-not-allowed` ab (403)', async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { origin: FOREIGN } });
    expect(res.status).toBe(403);
    const body = await res.json() as { error?: string; code?: string };
    expect(body.error).toBe('origin-not-allowed');
    expect(body.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('lässt Anfragen ohne Origin zu (curl, Lastverteiler-Probe)', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });
});
