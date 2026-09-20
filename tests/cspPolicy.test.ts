/**
 * F7-Fix: CSP aus der Umgebung abgeleitet, mit Meldeweg und Enforce-Schalter.
 * ==========================================================================
 * Befund: Die CSP war `Report-Only` und ihr `connect-src` erlaubte mit `https:`
 * und `wss:` praktisch jedes Ziel (Wildcard) – die Policy war damit wirkungslos.
 * Zusätzlich fehlte ein `report-uri`, d. h. Verstöße landeten nur in der
 * Browser-Konsole des jeweiligen Nutzers.
 *
 * Geprüft wird:
 *   1. keine Wildcards mehr in `connect-src`, stattdessen Hosts aus der Umgebung,
 *   2. `CSP_MODE=enforce` schaltet dieselbe Policy scharf (Header-Name wechselt),
 *   3. es gibt einen ECHTEN Meldeweg (tokenfrei, 204, datensparsam).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import {
  CSP_REPORT_PATH,
  buildCspPolicy,
  buildConnectSources,
  buildReportingHeaders,
  collectPolicyHosts,
  resolveCspMode,
  summarizeCspReport,
} from '../server/csp';
import { getCspViolations } from '../server/routes/securityRoutes';

/** Quellen einer Direktive aus der Policy ziehen (für gezielte Prüfungen). */
function directiveSources(policy: string, name: string): string[] {
  const part = policy.split('; ').find((d) => d.startsWith(`${name} `));
  return part ? part.slice(name.length + 1).split(' ') : [];
}

describe('F7: CSP-Policy (Einheit)', () => {
  it('hat standardmäßig keinen Wildcard in connect-src und nennt eine report-uri', () => {
    const policy = buildCspPolicy({ DOMAIN: 'app.example' });
    const sources = directiveSources(policy.value, 'connect-src');
    expect(sources).not.toContain('https:');
    expect(sources).not.toContain('wss:');
    expect(policy.value).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(policy.mode).toBe('report-only');
    expect(policy.headerName).toBe('Content-Security-Policy-Report-Only');
  });

  it('leitet die Hosts aus der Umgebung ab (Domain, Supabase/R2, Flotten-Ziele)', () => {
    const hosts = collectPolicyHosts({
      DOMAIN: 'anunnakitools.de',
      SUPABASE_URL: 'https://abcdefgh.supabase.co',
      CFR2_PUBLIC_URL: 'https://pub-123.r2.dev/audio/',
      MASTER_PLAYER_URL: 'http://10.0.0.5:8000/health',
      SIGNALING_ALLOWED_ORIGINS: 'https://anunnakitools.de,http://localhost:5173',
      CSP_ALLOWED_HOSTS: 'https://zusaetzlich.example',
    });
    expect(hosts).toContain('https://anunnakitools.de');
    expect(hosts).toContain('https://abcdefgh.supabase.co');
    expect(hosts).toContain('https://pub-123.r2.dev'); // Pfad wird verworfen
    expect(hosts).toContain('http://10.0.0.5:8000'); // Port bleibt
    expect(hosts).toContain('http://localhost:5173');
    expect(hosts).toContain('https://zusaetzlich.example');
    // Der Wildcard der Altkonfiguration darf NIE als Host durchrutschen.
    expect(hosts).not.toContain('*');
    expect(hosts).not.toContain('https://*');
  });

  it('nimmt wss-/ws-Varianten der abgeleiteten Hosts in connect-src auf (Signaling)', () => {
    const sources = buildConnectSources({ DOMAIN: 'anunnakitools.de', OLLAMA_URL: 'http://127.0.0.1:11434/api' });
    expect(sources).toContain('https://anunnakitools.de');
    expect(sources).toContain('wss://anunnakitools.de');
    expect(sources).toContain('http://127.0.0.1:11434');
    expect(sources).toContain('ws://127.0.0.1:11434');
  });

  it('CSP_MODE=enforce schaltet dieselbe Policy scharf', () => {
    const off = buildCspPolicy({ DOMAIN: 'app.example', CSP_MODE: 'report-only' });
    const on = buildCspPolicy({ DOMAIN: 'app.example', CSP_MODE: 'enforce' });
    expect(resolveCspMode({ CSP_MODE: 'enforce' })).toBe('enforce');
    expect(on.headerName).toBe('Content-Security-Policy');
    expect(on.value).toBe(off.value); // identischer Inhalt, nur andere Wirkung
    // Unbekannte Werte fallen auf den beobachtenden Modus zurueck (kein Unfall-Enforce).
    expect(resolveCspMode({ CSP_MODE: 'ja-bitte' })).toBe('report-only');
  });

  it('CSP_CONNECT_SRC übersteuert die Ableitung (Betreiber-Notausgang)', () => {
    const sources = buildConnectSources({ DOMAIN: 'app.example', CSP_CONNECT_SRC: "'self' https://nur-das.example" });
    expect(sources).toEqual(["'self'", 'https://nur-das.example']);
  });

  it('nimmt die vom CLIENT genutzten Ziele auf (VITE_SIGNALING_*, src/config/runtime.ts)', () => {
    // Cross-Host-Aufbau: der Browser verbindet sich zum Signaling auf einem
    // anderen Host als dem, der die Seite ausliefert. Ohne diese Quelle würde
    // eine scharfe Policy die Signalisierung kappen.
    const policy = buildCspPolicy({
      DOMAIN: 'app.example',
      VITE_SIGNALING_WS_URL: 'wss://signal.kunde.example',
      VITE_API_BASE_URL: 'https://api.kunde.example',
    });
    const sources = directiveSources(policy.value, 'connect-src');
    expect(sources).toContain('wss://signal.kunde.example');
    expect(sources).toContain('https://api.kunde.example');
    // Kein Wildcard, auch nicht durch die Client-Ziele.
    expect(sources).not.toContain('https:');
  });

  it('fasst einen CSP-Report datensparsam zusammen (nur Hosts, keine Pfade)', () => {
    const summary = summarizeCspReport({
      'csp-report': {
        'violated-directive': 'connect-src',
        'blocked-uri': 'https://tracker.example/collect?user=geheim',
        'document-uri': 'https://anunnakitools.de/studio?session=abc',
      },
    });
    expect(summary).toEqual({
      directive: 'connect-src',
      blockedHost: 'tracker.example',
      documentHost: 'anunnakitools.de',
    });
    expect(JSON.stringify(summary)).not.toContain('geheim');
    expect(summarizeCspReport({ irgendwas: 'anderes' })).toBeNull();
    expect(summarizeCspReport(null)).toBeNull();
  });

  it('bedient auch die moderne Reporting-API (Array von {type, body})', () => {
    // `report-to` schickt ein ARRAY. Ohne diese Form wäre der Meldeweg für genau
    // die Browser stumm, die die Reporting-API nutzen.
    const summary = summarizeCspReport([
      { type: 'csp-violation', body: { 'violated-directive': 'img-src', blockedURL: 'https://bild.example/x.png' } },
    ]);
    expect(summary).toEqual({ directive: 'img-src', blockedHost: 'bild.example', documentHost: '' });
    expect(summarizeCspReport([{ type: 'deprecation', body: { id: 'x' } }])).toBeNull();
  });

  it('bindet `report-to` an dieselbe Gruppe wie `Reporting-Endpoints`', () => {
    const policy = buildCspPolicy({ DOMAIN: 'app.example' });
    expect(policy.value).toContain('report-to default');
    expect(buildReportingHeaders()['Reporting-Endpoints']).toBe(`default="${CSP_REPORT_PATH}"`);
  });
});

describe('F7: CSP-Header und Meldeweg (HTTP)', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    process.env.VITEST = 'true';
    process.env.STUDIO_ACCESS_TOKEN = 'test-studio-token';
    process.env.DOMAIN = 'anunnakitools.de';
    process.env.API_RATE_LIMIT_MAX = '1000';
    // Kleines Budget für den Meldeweg (Default 120/min): beweist, dass der
    // Endpunkt NICHT unter dem allgemeinen Limiter hängt, sondern ein eigenes
    // enges Budget hat.
    process.env.CSP_REPORT_RATE_LIMIT_MAX = '3';
    const mod = await import('../server');
    server = mod.app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('kein Port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.STUDIO_ACCESS_TOKEN;
  });

  it('setzt die Policy auf jeder Antwort (Default: Report-Only) inkl. report-uri', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    const policy = res.headers.get('content-security-policy-report-only')
      ?? res.headers.get('content-security-policy');
    expect(policy).toBeTruthy();
    expect(policy).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(policy).toContain('https://anunnakitools.de');
    expect(res.headers.get('reporting-endpoints')).toContain(CSP_REPORT_PATH);
  });

  it('nimmt CSP-Reports OHNE Studio-Token an (204) und speichert sie datensparsam', async () => {
    const res = await fetch(`${baseUrl}${CSP_REPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: JSON.stringify({
        'csp-report': {
          'violated-directive': 'script-src',
          'blocked-uri': 'https://boese.example/payload.js?voll-lang',
          'document-uri': 'https://anunnakitools.de/',
        },
      }),
    });
    expect(res.status).toBe(204);
    const violations = getCspViolations();
    const last = violations[violations.length - 1];
    expect(last).toEqual({
      directive: 'script-src',
      blockedHost: 'boese.example',
      documentHost: 'anunnakitools.de',
    });
  });

  it('antwortet auch auf unbrauchbare Reports mit 204 (kein Feedback über Formate)', async () => {
    const res = await fetch(`${baseUrl}${CSP_REPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nichts: 'brauchbares' }),
    });
    expect(res.status).toBe(204);
  });

  it('hat ein eigenes, enges Budget (nicht das allgemeine, hier 1000/min)', async () => {
    // Der Endpunkt ist tokenfrei und darf kein Log-Verstärker sein. Läge er unter
    // dem allgemeinen Limiter (1000/min), käme hier nie ein 429.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push(await fetch(`${baseUrl}${CSP_REPORT_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/csp-report' },
        body: JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src' } }),
      }).then((r) => r.status));
    }
    const firstBlocked = statuses.indexOf(429);
    expect(firstBlocked).toBeGreaterThan(-1);
    expect(statuses.slice(0, firstBlocked)).toEqual(statuses.slice(0, firstBlocked).map(() => 204));
  });
});
