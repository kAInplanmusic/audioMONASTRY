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
 *   3. es gibt einen ECHTEN Meldeweg (tokenfrei, 204, datensparsam),
 *   4. er ist AUSWERTBAR (Zähler je Ausgang/Direktive/Ziel, Ablesestelle,
 *      Prometheus-Metrik) – und zwar für BEIDE Drahtformate des Browsers.
 *
 * (4) kam nach dem lokalen Beweislauf vom 2026-09-21 mit echtem Chrome 153:
 * die moderne Form (`application/reports+json`, camelCase, Array mit mehreren
 * Verstößen) wurde verworfen, und es gab keine Ablesestelle für den Betreiber.
 * Die dafür genutzten Nutzlasten unten sind die REAL mitgeschnittenen Bytes
 * dieses Laufs (nur `originalPolicy` ist zur Lesbarkeit gekürzt).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import {
  CSP_REPORT_PATH,
  buildCspPolicy,
  buildConnectSources,
  buildReportingHeaders,
  collectPolicyHosts,
  cspViolationTarget,
  resolveCspMode,
  summarizeCspReport,
  summarizeCspReports,
} from '../server/csp';
import {
  CSP_REPORTS_STATUS_PATH,
  getCspReportStats,
  getCspViolations,
  resetCspReportStats,
} from '../server/routes/securityRoutes';

/** Quellen einer Direktive aus der Policy ziehen (für gezielte Prüfungen). */
function directiveSources(policy: string, name: string): string[] {
  const part = policy.split('; ').find((d) => d.startsWith(`${name} `));
  return part ? part.slice(name.length + 1).split(' ') : [];
}

/**
 * Altformat (`report-uri`, `application/csp-report`) – wörtlich die Bytes, die
 * Chrome 153 im Beweislauf gesendet hat (Bindestrich-Schlüssel).
 */
const WIRE_LEGACY = {
  'csp-report': {
    'document-uri': 'https://anunnakitools.de/studio',
    'referrer': '',
    'violated-directive': 'img-src',
    'effective-directive': 'img-src',
    'original-policy': "img-src 'self' data: blob:",
    'disposition': 'report',
    'blocked-uri': 'https://fremd-bild.example/logo.png',
    'line-number': 2,
    'source-file': 'https://anunnakitools.de/studio',
    'status-code': 200,
    'script-sample': '',
  },
};

/**
 * Modernes Format (`report-to`, `application/reports+json`) – wörtlich die
 * Bytes aus dem Beweislauf: EIN POST, ZWEI Meldungen (`media-src` UND
 * `script-src-elem`), camelCase-Schlüssel, `blockedURL: 'inline'` als
 * CSP-Sonderwert. Genau diese Form schickt Chrome, sobald die Policy
 * `report-to` nennt (unsere nennt es).
 */
const WIRE_MODERN = [
  {
    age: 0,
    body: {
      blockedURL: 'https://fremd-bild.example/logo.png',
      disposition: 'report',
      documentURL: 'https://anunnakitools.de/studio',
      effectiveDirective: 'img-src',
      lineNumber: 2,
      originalPolicy: "img-src 'self' data: blob:",
      referrer: '',
      sample: '',
      sourceFile: 'https://anunnakitools.de/studio',
      statusCode: 200,
    },
    type: 'csp-violation',
    url: 'https://anunnakitools.de/studio',
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  },
  {
    age: 5744,
    body: {
      blockedURL: 'https://fremd-audio.example/kick.wav',
      disposition: 'report',
      documentURL: 'https://anunnakitools.de/studio',
      effectiveDirective: 'media-src',
      lineNumber: 5,
      originalPolicy: "media-src 'self' blob: data:",
      referrer: '',
      sample: '',
      sourceFile: 'https://anunnakitools.de/studio',
      statusCode: 200,
    },
    type: 'csp-violation',
    url: 'https://anunnakitools.de/studio',
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  },
];

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

  it('CSP_MODE=enforce schaltet dieselbe Policy scharf - aber nur in Produktion', () => {
    const off = buildCspPolicy({ DOMAIN: 'app.example', CSP_MODE: 'report-only', NODE_ENV: 'production' });
    const on = buildCspPolicy({ DOMAIN: 'app.example', CSP_MODE: 'enforce', NODE_ENV: 'production' });
    expect(resolveCspMode({ CSP_MODE: 'enforce', NODE_ENV: 'production' })).toBe('enforce');
    expect(on.headerName).toBe('Content-Security-Policy');
    expect(on.value).toBe(off.value); // identischer Inhalt, nur andere Wirkung
    // Unbekannte Werte fallen auf den beobachtenden Modus zurueck (kein Unfall-Enforce).
    expect(resolveCspMode({ CSP_MODE: 'ja-bitte' })).toBe('report-only');
  });

  it('ausserhalb der Produktion bleibt enforce meldend - sonst ist npm run dev eine weisse Seite', () => {
    // GEFUNDEN AM 2026-09-24: mit CSP_MODE=enforce (in der .env gesetzt) lieferte
    // `npm run dev` eine WEISSE SEITE. Der Vite-Dev-Server bettet ein
    // Inline-Skript ein, und `script-src 'self'` blockt genau das. Im Browser war
    // davon nur eine CSP-Zeile in der Konsole zu sehen - wer das Repo klont,
    // haelt die App fuer kaputt.
    expect(resolveCspMode({ CSP_MODE: 'enforce' })).toBe('report-only');
    expect(resolveCspMode({ CSP_MODE: 'enforce', NODE_ENV: 'development' })).toBe('report-only');
    expect(resolveCspMode({ CSP_MODE: 'enforce', NODE_ENV: 'test' })).toBe('report-only');
    // Der Inhalt der Policy bleibt gleich - nur die Wirkung ist im Dev-Modus aus.
    const dev = buildCspPolicy({ DOMAIN: 'app.example', CSP_MODE: 'enforce', NODE_ENV: 'development' });
    const prod = buildCspPolicy({ DOMAIN: 'app.example', CSP_MODE: 'enforce', NODE_ENV: 'production' });
    expect(dev.value).toBe(prod.value);
    expect(dev.headerName).toBe('Content-Security-Policy-Report-Only');
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

  it('nimmt den SFU-Signalisierungshost auf (eigener Name, NICHT von self gedeckt)', () => {
    // Live gemessen (2026-09-21): der laufende Header enthielt den gesetzten
    // SFU-Host NICHT. Der Client verbindet sich aber genau dorthin (socket.io,
    // src/core/transport/sfuEndpoint.ts) – unter `enforce` waere die
    // Signalisierung gekappt worden.
    const policy = buildCspPolicy({
      DOMAIN: 'anunnakitools.de',
      SFU_SIGNALING_URL: 'https://sfu.anunnakitools.de',
      VITE_SFU_URL: 'https://sfu2.anunnakitools.de',
    });
    const sources = directiveSources(policy.value, 'connect-src');
    expect(sources).toContain('https://sfu.anunnakitools.de');
    expect(sources).toContain('wss://sfu.anunnakitools.de');
    expect(sources).toContain('https://sfu2.anunnakitools.de');
    // Auch in img-/media-src, weil dort dieselben Host-Quellen haengen.
    expect(directiveSources(policy.value, 'img-src')).toContain('https://sfu.anunnakitools.de');
  });

  it('nimmt die Browser-Aliase von Supabase/R2 auf (src/lib/cloudConfig.ts)', () => {
    const hosts = collectPolicyHosts({
      VITE_SUPABASE_URL: 'https://alias.supabase.co',
      VITE_CFR2_PUBLIC_URL: 'https://pub-alias.r2.dev',
    });
    expect(hosts).toContain('https://alias.supabase.co');
    expect(hosts).toContain('https://pub-alias.r2.dev');
  });

  it('leitet den R2-S3-Endpunkt ab (Account+Bucket, wie der Client selbst)', () => {
    const hosts = collectPolicyHosts({
      CFR2_ACCOUNT_ID: 'deadbeefdeadbeefdeadbeefdeadbeef',
      CFS3_BUCKET: 'audiomonastry',
    });
    expect(hosts).toContain('https://audiomonastry.deadbeefdeadbeefdeadbeefdeadbeef.r2.cloudflarestorage.com');
    // Ohne vollstaendiges Paar entsteht KEINE kaputte CSP-Quelle.
    expect(collectPolicyHosts({ CFR2_ACCOUNT_ID: 'x' })).not.toContain('https://undefined');
    expect(collectPolicyHosts({ CFR2_ACCOUNT_ID: 'deadbeef', CFS3_BUCKET: 'a' })).toEqual([]);
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
      blockedKeyword: '',
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
    expect(summary).toEqual({
      directive: 'img-src',
      blockedHost: 'bild.example',
      documentHost: '',
      blockedKeyword: '',
    });
    expect(summarizeCspReport([{ type: 'deprecation', body: { id: 'x' } }])).toBeNull();
  });

  it('liest die camelCase-Bytes der Reporting-API (Chrome 153, echt mitgeschnitten)', () => {
    const entries = summarizeCspReports(WIRE_MODERN);
    // Ein POST, ZWEI Meldungen: wer nur das erste Element liest, verliert eine.
    expect(entries).toEqual([
      { directive: 'img-src', blockedHost: 'fremd-bild.example', documentHost: 'anunnakitools.de', blockedKeyword: '' },
      { directive: 'media-src', blockedHost: 'fremd-audio.example', documentHost: 'anunnakitools.de', blockedKeyword: '' },
    ]);
    // Kein Pfad/Query dieser URL darf im Ergebnis landen.
    expect(JSON.stringify(entries)).not.toContain('/logo.png');
  });

  it('liest das Altformat der Report-uri (Bindestrich-Schlüssel, echt mitgeschnitten)', () => {
    expect(summarizeCspReports(WIRE_LEGACY)).toEqual([
      { directive: 'img-src', blockedHost: 'fremd-bild.example', documentHost: 'anunnakitools.de', blockedKeyword: '' },
    ]);
  });

  it('bevorzugt die effektive Direktive und behält CSP-Sonderwerte als Ziel', () => {
    // Chrome setzt `violated-directive: script-src-elem` und
    // `effective-directive: script-src` - fachlich dieselbe Direktive. Ohne
    // diese Wahl zersplittern die Zaehler in -elem-Varianten.
    const [summary] = summarizeCspReports({
      'csp-report': {
        'violated-directive': 'script-src-elem',
        'effective-directive': 'script-src',
        'blocked-uri': 'inline',
        'document-uri': 'https://anunnakitools.de/studio',
      },
    });
    expect(summary.directive).toBe('script-src');
    expect(summary.blockedHost).toBe(''); // 'inline' ist kein Host
    expect(summary.blockedKeyword).toBe('inline'); // aber auch keine Nullaussage
    expect(cspViolationTarget(summary)).toBe('inline');
    // `data:` (Favicon) wird als Sonderwert geführt, nicht als leerer Host.
    const [favicon] = summarizeCspReports({ 'csp-report': { 'violated-directive': 'img-src', 'blocked-uri': 'data' } });
    expect(favicon.blockedKeyword).toBe('data');
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
    process.env.SFU_SIGNALING_URL = 'https://sfu.anunnakitools.de';
    // Origin-Allowlist der API aktiv: nur so ist unten beweisbar, dass der
    // Meldeendpunkt davon AUSGENOMMEN ist (gemessen: fremder Dokument-Origin
    // bekam vorher 403 ORIGIN_NOT_ALLOWED - der Report war still verloren).
    process.env.API_ALLOWED_ORIGINS = 'https://anunnakitools.de';
    process.env.API_RATE_LIMIT_MAX = '1000';
    // Eigenes Budget des Meldewegs. Kleiner als das allgemeine Budget (1000),
    // damit der eigene Limiter unten beweisbar ist; die Zähl-Tests davor
    // verbrauchen nur wenige Anfragen.
    process.env.CSP_REPORT_RATE_LIMIT_MAX = '8';
    const mod = await import('../server');
    server = mod.app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('kein Port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.STUDIO_ACCESS_TOKEN;
    delete process.env.SFU_SIGNALING_URL;
  });

  beforeEach(() => {
    resetCspReportStats();
  });

  const postReport = (contentType: string, body: unknown) =>
    fetch(`${baseUrl}${CSP_REPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('setzt die Policy auf jeder Antwort (Default: Report-Only) inkl. report-uri', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    const policy = res.headers.get('content-security-policy-report-only')
      ?? res.headers.get('content-security-policy');
    expect(policy).toBeTruthy();
    expect(policy).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(policy).toContain('https://anunnakitools.de');
    expect(policy).toContain('https://sfu.anunnakitools.de');
    expect(res.headers.get('reporting-endpoints')).toContain(CSP_REPORT_PATH);
  });

  it('nimmt CSP-Reports OHNE Studio-Token an (204) und speichert sie datensparsam', async () => {
    const res = await postReport('application/csp-report', WIRE_LEGACY);
    expect(res.status).toBe(204);
    const violations = getCspViolations();
    const last = violations[violations.length - 1];
    expect(last).toEqual({
      directive: 'img-src',
      blockedHost: 'fremd-bild.example',
      documentHost: 'anunnakitools.de',
      blockedKeyword: '',
    });
  });

  it('zaehlt auch die moderne Form vollstaendig (ein POST, zwei Meldungen)', async () => {
    const res = await postReport('application/reports+json', WIRE_MODERN);
    expect(res.status).toBe(204);
    const stats = getCspReportStats();
    expect(stats.received).toBe(1);
    expect(stats.violations).toBe(2);
    expect(stats.unusable).toBe(0);
    expect(stats.byDirective).toEqual({ 'img-src': 1, 'media-src': 1 });
    expect(stats.byTarget).toEqual({ 'fremd-bild.example': 1, 'fremd-audio.example': 1 });
    expect(stats.byDocument).toEqual({ 'anunnakitools.de': 2 });
    expect(stats.recent).toHaveLength(2);
    expect(stats.mode).toBe('report-only');
    expect(stats.headerName).toBe('Content-Security-Policy-Report-Only');
  });

  it('trennt unbrauchbare von verwendbaren Meldungen (Auswertbarkeit)', async () => {
    const res = await postReport('application/json', { nichts: 'brauchbares' });
    expect(res.status).toBe(204);
    const stats = getCspReportStats();
    expect(stats.received).toBe(1);
    expect(stats.violations).toBe(0);
    expect(stats.unusable).toBe(1);
    expect(stats.lastReceivedAt).toBeTypeOf('number');
    expect(stats.byDirective).toEqual({});
  });

  it('verwirft zu grosse Bodies und zaehlt sie als oversized', async () => {
    const huge = JSON.stringify([{ type: 'csp-violation', body: { effectiveDirective: 'script-src', blockedURL: `https://x.example/${'a'.repeat(40_000)}` } }]);
    const res = await postReport('application/reports+json', huge);
    expect(res.status).toBe(204);
    const stats = getCspReportStats();
    expect(stats.oversized).toBe(1);
    expect(stats.violations).toBe(0);
  });

  it('nimmt Reports auch von einem fremden Dokument-Origin an (nicht die API-Allowlist)', async () => {
    // Ein Browser schickt beim CSP-Report den Origin des DOKUMENTS. Steht der
    // nicht in API_ALLOWED_ORIGINS (www.-Variante, alte IP, Vorschau-Host), war
    // der Report vorher ein 403 `ORIGIN_NOT_ALLOWED` - still und ungezaehlt.
    const res = await fetch(`${baseUrl}${CSP_REPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report', Origin: 'https://vorschau.example' },
      body: JSON.stringify({
        'csp-report': {
          'violated-directive': 'img-src',
          'blocked-uri': 'https://fremd-origin.example/logo.png',
          'document-uri': 'https://vorschau.example/studio',
        },
      }),
    });
    expect(res.status).toBe(204);
    const stats = getCspReportStats();
    expect(stats.violations).toBe(1);
    expect(stats.byTarget['fremd-origin.example']).toBe(1);
  });

  it('stellt die Auswertung unter GET /api/security/csp-reports bereit (tokenpflichtig)', async () => {
    await postReport('application/reports+json', WIRE_MODERN);
    // Ohne Token: kein Einblick in den Betriebszustand (die Route ist NICHT
    // tokenfrei - nur der Meldeendpunkt selbst muss es sein).
    const anon = await fetch(`${baseUrl}${CSP_REPORTS_STATUS_PATH}`);
    expect(anon.status).toBe(401);
    const res = await fetch(`${baseUrl}${CSP_REPORTS_STATUS_PATH}`, {
      headers: { 'x-studio-token': 'test-studio-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('report-only');
    expect(body.violations).toBe(2);
    expect(body.byDirective).toEqual({ 'img-src': 1, 'media-src': 1 });
    expect(body.recent).toHaveLength(2);
  });

  it('spiegelt die Zaehler in /api/metrics (Prometheus + JSON) fuer Dashboard/Alert', async () => {
    await postReport('application/reports+json', WIRE_MODERN);
    const prom = await fetch(`${baseUrl}/api/metrics?format=prometheus`, {
      headers: { 'x-studio-token': 'test-studio-token' },
    });
    expect(prom.status).toBe(200);
    const text = await prom.text();
    expect(text).toContain('audiomonastry_csp_mode_report_only 1');
    expect(text).toContain('audiomonastry_csp_reports_total{outcome="usable"} 2');
    expect(text).toContain('audiomonastry_csp_violations_by_directive_total{directive="media-src"} 1');
    expect(text).toContain('audiomonastry_csp_violations_by_target_total{target="fremd-bild.example"} 1');

    const json = await fetch(`${baseUrl}/api/metrics`, { headers: { 'x-studio-token': 'test-studio-token' } });
    const payload = await json.json() as Record<string, any>;
    expect(payload.csp.mode).toBe('report-only');
    expect(payload.csp.violations).toBe(2);
    expect(payload.csp.byDirective).toEqual({ 'img-src': 1, 'media-src': 1 });
    expect(payload.csp.recent).toBeUndefined(); // Ringpuffer bleibt der Detailroute
  });
});

describe('F7: Budget des Meldewegs (HTTP)', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    process.env.VITEST = 'true';
    process.env.STUDIO_ACCESS_TOKEN = 'test-studio-token';
    process.env.API_RATE_LIMIT_MAX = '1000';
    // Der Limiter wird beim Import von server.ts EINMAL gebaut (Modul-Cache);
    // dieser Wert greift hier deshalb nur, wenn dieses Describe isoliert laeuft.
    // Die Zaehlungen unten haengen nicht daran (sie rechnen mit dem tatsaechlich
    // beobachteten ersten 429).
    process.env.CSP_REPORT_RATE_LIMIT_MAX = '5';
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

  it('hat ein eigenes, enges Budget (nicht das allgemeine, hier 1000/min)', async () => {
    // Der Endpunkt ist tokenfrei und darf kein Log-Verstärker sein. Läge er unter
    // dem allgemeinen Limiter (1000/min), käme hier nie ein 429.
    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      statuses.push((await fetch(`${baseUrl}${CSP_REPORT_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/csp-report' },
        body: JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src' } }),
      })).status);
    }
    const firstBlocked = statuses.indexOf(429);
    expect(firstBlocked).toBeGreaterThan(-1);
    // Alles vor dem ersten 429 war angenommen (204) - kein stiller Totalausfall.
    expect(statuses.slice(0, firstBlocked)).toEqual(statuses.slice(0, firstBlocked).map(() => 204));
    // Gedrosselte Reports sind gezaehlt: eine Flut waere sonst unsichtbar.
    expect(getCspReportStats().throttled).toBe(statuses.length - firstBlocked);
  });

  it('deckt mit dem Limiter NICHT die Auswertungs-Route ab', async () => {
    // Das Budget ist oben aufgebraucht; die Ablesestelle muss trotzdem
    // antworten (sonst waere die Auswertung genau im Report-Flutfall blind).
    const res = await fetch(`${baseUrl}${CSP_REPORTS_STATUS_PATH}`, {
      headers: { 'x-studio-token': 'test-studio-token' },
    });
    expect(res.status).toBe(200);
  });
});
