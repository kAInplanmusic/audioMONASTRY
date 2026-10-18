/**
 * FIX F2 · Tests für R2-Konfiguration, Schreibprobe und Fehlerklassifikation
 * =========================================================================
 * Kein Netzwerk: der „R2-Endpoint“ ist ein lokaler HTTP-Stub (`127.0.0.1`).
 * Der Aufruf geht trotzdem durch den ECHTEN Pfad – `S3Client` aus
 * `@aws-sdk/client-s3` signiert und schickt einen echten PUT/DELETE; nur die
 * Gegenseite ist ein Stub. Was der Stub NICHT nachstellen kann, ist die
 * kryptografische Signaturprüfung von Cloudflare R2 – deshalb antwortet er im
 * Fehlerfall mit derselben XML-Antwort wie R2 (`SignatureDoesNotMatch`) und der
 * Test prüft zusätzlich, mit WELCHEM Access-Key tatsächlich signiert wurde.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  classifyR2Problem,
  isRetryableR2Problem,
  isR2StateThrottleSignature,
  logR2Once,
  probeR2,
  r2ProblemHint,
  resetR2ErrorThrottle,
  resetR2HealthForTests,
  runR2HealthCheck,
  suppressedR2LogCount,
} from '../server/r2Health';
import { resolveR2Config } from '../server/r2Config';

// 32 Hex (Access Key) / 64 Hex (Secret) – R2-Format.
const ACCESS_KEY = 'a'.repeat(32);
const SECRET_KEY = 'b'.repeat(64);
const OTHER_ACCESS_KEY = 'c'.repeat(32);
const OTHER_SECRET_KEY = 'd'.repeat(64);
const BUCKET = 'audiomonastrysamples';

interface StubState {
  requests: { method: string; url: string; authorization: string }[];
  putCount: number;
  deleteCount: number;
}

interface StubOptions {
  /**
   * Antwort auf PUT:
   * 'ok' | 'signature' (403 SignatureDoesNotMatch) | 'hang' (Timeout) |
   * 'access-denied' (403) | 'not-found' (404) | 'invalid-argument' (400) |
   * 'server-error' (503).
   */
  put?: 'ok' | 'signature' | 'hang' | 'access-denied' | 'not-found' | 'invalid-argument' | 'server-error';
}

/**
 * Fehlerantworten des Stubs im R2/S3-XML-Protokoll. `status` + `code` bilden die
 * Klassen, die der Health-Snapshot unterscheiden muss (DA-2026-10-17-001):
 * retrybar (5xx/Timeout) vs. nicht-retrybar (401/403/404/InvalidArgument).
 */
const STUB_FAILURES: Record<
  'access-denied' | 'not-found' | 'invalid-argument' | 'server-error',
  { status: number; code: string; message: string }
> = {
  'access-denied': { status: 403, code: 'AccessDenied', message: 'Access Denied' },
  'not-found': { status: 404, code: 'NoSuchKey', message: 'The specified key does not exist.' },
  'invalid-argument': { status: 400, code: 'InvalidArgument', message: 'Invalid argument' },
  'server-error': { status: 503, code: 'ServiceUnavailable', message: 'Please reduce your request rate.' },
};

/** Lokaler R2-Stub: Antwortet im R2/S3-Protokoll, ohne Signaturprüfung. */
async function startStub(options: StubOptions = {}): Promise<{ base: string; state: StubState; close: () => Promise<void> }> {
  const state: StubState = { requests: [], putCount: 0, deleteCount: 0 };
  const server: Server = http.createServer((req, res) => {
    state.requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: String(req.headers.authorization ?? ''),
    });
    req.resume();
    req.on('end', () => {
      if (req.method === 'PUT') {
        state.putCount += 1;
        if (options.put === 'signature') {
          res.writeHead(403, { 'Content-Type': 'application/xml' });
          res.end(
            '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code>'
            + '<Message>The request signature we calculated does not match the signature you provided.</Message>'
            + '<RequestId>stub-1</RequestId></Error>',
          );
          return;
        }
        if (options.put === 'hang') return; // Antwortet nie → Timeout-Pfad
        if (options.put && options.put !== 'ok') {
          const failure = STUB_FAILURES[options.put];
          res.writeHead(failure.status, { 'Content-Type': 'application/xml' });
          res.end(
            '<?xml version="1.0" encoding="UTF-8"?>'
            + `<Error><Code>${failure.code}</Code><Message>${failure.message}</Message>`
            + '<RequestId>stub-2</RequestId></Error>',
          );
          return;
        }
        res.writeHead(200, { ETag: '"stub-etag"' });
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        state.deleteCount += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(400).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    state,
    // `closeAllConnections` ist nötig, weil der Timeout-Stub eine Verbindung
    // absichtlich offen lässt – sonst hing der Teardown.
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

function envFor(base: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    CFS3_ENDPOINT: base,
    CFS3_ACCESS_KEY: ACCESS_KEY,
    CFS3_SECRET_KEY: SECRET_KEY,
    CFS3_BUCKET: BUCKET,
    ...extra,
  };
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetR2HealthForTests();
  for (const key of ['R2_PROBE_TIMEOUT_MS', 'R2_HEALTH_TTL_MS']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('resolveR2Config – eine Herkunft, Abweichungen laut', () => {
  it('liest die auf app-1 gesetzten Namen CFS3_ACCESS_KEY_ID/CFS3_SECRET_ACCESS_KEY (F2-Regression)', () => {
    // Der Live-Befund: genau diese beiden Namen wurden vom Server IGNORIERT,
    // danach fiel er still auf CFR2_* zurück (falsches Paar → Signaturfehler).
    const config = resolveR2Config({
      CFS3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      CFS3_ACCESS_KEY_ID: ACCESS_KEY,
      CFS3_SECRET_ACCESS_KEY: SECRET_KEY,
      CFS3_BUCKET: BUCKET,
    });
    expect(config.accessKeyId).toBe(ACCESS_KEY);
    expect(config.secretAccessKey).toBe(SECRET_KEY);
    expect(config.configured).toBe(true);
    expect(config.usedEnvKeys).toContain('CFS3_ACCESS_KEY_ID');
    expect(config.usedEnvKeys).toContain('CFS3_SECRET_ACCESS_KEY');
  });

  it('meldet widersprüchliche Quellen als deviation – ohne Secret-Werte', () => {
    const config = resolveR2Config({
      CFS3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      CFS3_BUCKET: BUCKET,
      // Portal-Rolle schreibt CFR2_*, die Knoten-.env trägt andere CFS3_*-Werte.
      CFS3_ACCESS_KEY: ACCESS_KEY,
      CFR2_ACCESS_KEY_ID: OTHER_ACCESS_KEY,
      CFS3_SECRET_KEY: SECRET_KEY,
      CFR2_SECRET_ACCESS_KEY: OTHER_SECRET_KEY,
    });
    const fields = config.deviation.map((d) => d.field).sort();
    expect(fields).toEqual(['accessKeyId', 'secretAccessKey']);
    expect(config.deviation[0].chosen).toBe('CFS3_ACCESS_KEY');
    // Benutzt wird die kanonische Familie, die Abweichung ist trotzdem sichtbar.
    expect(config.accessKeyId).toBe(ACCESS_KEY);
    expect(config.ignoredEnvKeys).toContain('CFR2_ACCESS_KEY_ID');
    // Fingerabdruck ja, Klartext nein:
    const serialized = JSON.stringify(config.deviation);
    expect(serialized).not.toContain(ACCESS_KEY);
    expect(serialized).not.toContain(OTHER_SECRET_KEY);
    expect(config.deviation[0].values.some((v) => /^[0-9a-f]{8}$/.test(v.fingerprint))).toBe(true);
  });

  it('benennt Formatfehler statt sie zu verschweigen', () => {
    const config = resolveR2Config({
      CFS3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      CFS3_BUCKET: BUCKET,
      CFS3_ACCESS_KEY: 'kein-hex-sondern-quatsch',
      CFS3_SECRET_KEY: SECRET_KEY,
    });
    expect(config.hasCredentials).toBe(true);
    expect(config.problems).toContain('access-key-shape');
    expect(config.configured).toBe(false);
  });
});

describe('probeR2 – echtes Probeobjekt gegen lokalen Stub', () => {
  it('schreibt und löscht ein Probeobjekt und signiert mit dem aufgelösten Paar', async () => {
    const stub = await startStub();
    try {
      const config = resolveR2Config(envFor(stub.base));
      const result = await probeR2(config, { timeoutMs: 2_000 });

      expect(result.ok).toBe(true);
      expect(result.problem).toBeNull();
      expect(result.method).toBe('PUT+DELETE');
      expect(result.bucket).toBe(BUCKET);
      expect(result.key).toMatch(/^probes\/r2-health-/);
      expect(stub.state.putCount).toBe(1);
      expect(stub.state.deleteCount).toBe(1);

      const put = stub.state.requests.find((r) => r.method === 'PUT');
      // Beweis, dass die Probe über den echten S3-Signaturpfad läuft:
      expect(put?.authorization).toContain('AWS4-HMAC-SHA256');
      expect(put?.authorization).toContain(`Credential=${ACCESS_KEY}/`);
      // Kein Rest im Bucket: nach dem Lauf bleibt nichts liegen.
      expect(stub.state.requests.filter((r) => r.method === 'DELETE').length).toBe(1);
    } finally {
      await stub.close();
    }
  });

  it('klassifiziert SignatureDoesNotMatch als signature-mismatch (Zustand error)', async () => {
    const stub = await startStub({ put: 'signature' });
    try {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const env = envFor(stub.base);

      const first = await runR2HealthCheck({ env, force: true });
      expect(first.ok).toBe(false);
      expect(first.problem).toBe('signature-mismatch');
      // DA-2026-10-17-001: deterministischer Fehler → 'error', nicht 'degraded'.
      expect(first.state).toBe('error');
      expect(first.status).toMatch(/^error: /);
      expect(first.credentials.source).toContain('CFS3_ACCESS_KEY');
      expect(stub.state.putCount).toBe(1); // keine stille SDK-Wiederholung

      // Zweiter Lauf: der Zustand bleibt, es gibt aber KEINE zweite Log-Zeile.
      const second = await runR2HealthCheck({ env, force: true });
      expect(second.problem).toBe('signature-mismatch');
      const signatureWarnings = errorSpy.mock.calls.filter((call) => String(call[0]).includes('[signature-mismatch]'));
      // Genau EINE Warnung für zwei Läufe – das ist der Fix gegen die Log-Flut.
      expect(signatureWarnings).toHaveLength(1);
      expect(suppressedR2LogCount('r2:signature-mismatch')).toBe(1);
      expect(stub.state.putCount).toBe(2);
    } finally {
      vi.restoreAllMocks();
      await stub.close();
    }
  });

  it('bricht die Probe nach dem Timeout ab, statt zu hängen', async () => {
    const stub = await startStub({ put: 'hang' });
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const config = resolveR2Config(envFor(stub.base));
      const started = Date.now();
      const result = await probeR2(config, { timeoutMs: 400 });
      const elapsed = Date.now() - started;

      expect(result.ok).toBe(false);
      expect(result.problem).toBe('timeout');
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      vi.restoreAllMocks();
      await stub.close();
    }
  });

  it('meldet unconfigured ohne Zugangsdaten – und macht dafür KEINEN Netzaufruf', async () => {
    const stub = await startStub();
    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const snapshot = await runR2HealthCheck({ env: { CFS3_ENDPOINT: stub.base, CFS3_BUCKET: BUCKET } });

      expect(snapshot.state).toBe('unconfigured');
      expect(snapshot.status).toBe('not-configured');
      expect(snapshot.ok).toBe(false);
      expect(snapshot.problem).toBe('not-configured');
      expect(stub.state.requests).toHaveLength(0);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('NICHT konfiguriert'))).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await stub.close();
    }
  });

  it('cached das Ergebnis (TTL) und misst mit force neu', async () => {
    const stub = await startStub();
    try {
      process.env.R2_HEALTH_TTL_MS = '60000';
      const env = envFor(stub.base);

      const a = await runR2HealthCheck({ env });
      const b = await runR2HealthCheck({ env });
      expect(a.ok).toBe(true);
      expect(b.checkedAt).toBe(a.checkedAt);
      expect(stub.state.putCount).toBe(1);

      const forced = await runR2HealthCheck({ env, force: true });
      expect(forced.ok).toBe(true);
      expect(stub.state.putCount).toBe(2);
    } finally {
      await stub.close();
    }
  });

  it('setzt die Log-Unterdrückung nach erfolgreicher Probe zurück', async () => {
    const failing = await startStub({ put: 'signature' });
    const healthy = await startStub();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.R2_HEALTH_TTL_MS = '0';

      await runR2HealthCheck({ env: envFor(failing.base) });
      await runR2HealthCheck({ env: envFor(failing.base) });
      // 1× geloggt, 1× unterdrückt.
      expect(suppressedR2LogCount('r2:signature-mismatch')).toBe(1);
      // Erholung: R2 antwortet wieder korrekt → Zustand ok, Unterdrückung weg.
      const recovered = await runR2HealthCheck({ env: envFor(healthy.base) });
      expect(recovered.state).toBe('ok');
      expect(suppressedR2LogCount('r2:signature-mismatch')).toBe(0);
      expect(healthy.state.putCount).toBe(1);
    } finally {
      vi.restoreAllMocks();
      await failing.close();
      await healthy.close();
    }
  });
});

describe('classifyR2Problem / Retry-Politik', () => {
  it('erkennt Signatur-, Rechte-, Bucket- und Transportfehler', () => {
    expect(classifyR2Problem(Object.assign(new Error('The request signature we calculated does not match the signature you provided'), { name: 'SignatureDoesNotMatch' })).problem)
      .toBe('signature-mismatch');
    expect(classifyR2Problem(Object.assign(new Error('Forbidden'), { name: 'AccessDenied' })).problem).toBe('access-denied');
    expect(classifyR2Problem(Object.assign(new Error('no bucket'), { name: 'NoSuchBucket' })).problem).toBe('no-such-bucket');
    expect(classifyR2Problem(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })).problem).toBe('unreachable');
    expect(classifyR2Problem(Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } })).problem).toBe('http-error');
    expect(classifyR2Problem(Object.assign(new Error('abgebrochen'), { name: 'TimeoutError' })).problem).toBe('timeout');
  });

  it('wiederholt nur Transportfehler – ein Signaturfehler ist deterministisch', () => {
    expect(isRetryableR2Problem('timeout')).toBe(true);
    expect(isRetryableR2Problem('unreachable')).toBe(true);
    expect(isRetryableR2Problem('http-error')).toBe(true);
    expect(isRetryableR2Problem('signature-mismatch')).toBe(false);
    expect(isRetryableR2Problem('access-denied')).toBe(false);
    expect(isRetryableR2Problem('not-configured')).toBe(false);
  });

  it('nennt für jeden Fehlercode eine Betreiber-Anweisung', () => {
    expect(r2ProblemHint('signature-mismatch')).toContain('OPS_RUNBOOK');
    expect(r2ProblemHint('not-configured')).toContain('unconfigured');
    expect(r2ProblemHint('timeout')).toContain('Timeout');
    expect(r2ProblemHint('invalid-argument')).toContain('InvalidArgument');
    expect(r2ProblemHint('not-found')).toContain('404');
  });
});

/**
 * DA-2026-10-17-001
 * =================
 * Befund: Der Health-Pfad stufte JEDEN fehlgeschlagenen Probe als `degraded` ein
 * – auch `signature-mismatch`, `access-denied`, `not-found` und
 * `invalid-argument`, die sich durch Wiederholen nie heilen. Nur der parallele
 * Schreibpfad (`recordR2Write`) unterschied korrekt. Folge: /api/metrics und
 * /api/cloud/health zeigten eine dauerhaft gerissene Konfiguration als
 * „degraded“, also optisch selbstheilend.
 *
 * Vertrag jetzt: retrybar (5xx/Timeout/Netz) → `degraded`; nicht-retrybar
 * (401/403/404/InvalidArgument) → `error`; der `status`-Präfix folgt dem State.
 */
describe('DA-2026-10-17-001 – Health-Snapshot trennt retrybar von nicht-retrybar', () => {
  async function snapshotFor(
    put: StubOptions['put'],
    extra: Record<string, string> = {},
    timeoutMs?: number,
  ) {
    const stub = await startStub({ put });
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      return await runR2HealthCheck({ env: envFor(stub.base, extra), force: true, timeoutMs });
    } finally {
      vi.restoreAllMocks();
      await stub.close();
    }
  }

  it('403 AccessDenied → error (nicht-retrybar)', async () => {
    const snapshot = await snapshotFor('access-denied');
    expect(snapshot.problem).toBe('access-denied');
    expect(snapshot.state).toBe('error');
    expect(snapshot.ok).toBe(false);
    expect(snapshot.status).toMatch(/^error: /);
  });

  it('404 → error (not-found, eigener Code statt probe-failed)', async () => {
    const snapshot = await snapshotFor('not-found');
    expect(snapshot.problem).toBe('not-found');
    expect(snapshot.state).toBe('error');
    expect(snapshot.status).toMatch(/^error: /);
  });

  it('400 InvalidArgument → error (invalid-argument)', async () => {
    const snapshot = await snapshotFor('invalid-argument');
    expect(snapshot.problem).toBe('invalid-argument');
    expect(snapshot.state).toBe('error');
    expect(snapshot.status).toMatch(/^error: /);
  });

  it('503 → degraded (retrybar) – Status-Präfix folgt dem State', async () => {
    const snapshot = await snapshotFor('server-error');
    expect(snapshot.problem).toBe('http-error');
    expect(snapshot.state).toBe('degraded');
    expect(snapshot.status).toMatch(/^degraded: /);
    expect(snapshot.ok).toBe(false);
  });

  it('Timeout → degraded (retrybar)', async () => {
    const snapshot = await snapshotFor('hang', {}, 300);
    expect(snapshot.problem).toBe('timeout');
    expect(snapshot.state).toBe('degraded');
  });

  it('Schreibpfad und Health-Snapshot stufen dieselbe Fehlerklasse identisch ein', async () => {
    // Der eigentliche Audit-Punkt: zwei Pfade, eine Einstufung.
    const retryable = ['timeout', 'unreachable', 'http-error'] as const;
    const permanent = ['signature-mismatch', 'access-denied', 'invalid-access-key', 'no-such-bucket', 'invalid-argument', 'not-found'] as const;
    expect(retryable.every((problem) => isRetryableR2Problem(problem))).toBe(true);
    expect(permanent.every((problem) => isRetryableR2Problem(problem))).toBe(false);

    const permanentSnapshots = await Promise.all([
      snapshotFor('signature'),
      snapshotFor('access-denied'),
      snapshotFor('not-found'),
      snapshotFor('invalid-argument'),
    ]);
    for (const snapshot of permanentSnapshots) {
      expect(snapshot.state).toBe('error');
    }
  });
});

/**
 * DA-2026-10-17-002
 * =================
 * Befund: Im selben Lauf wurden `r2:deviation`/`r2:ignored-keys` gesetzt, danach
 * löschte der Recovery-Reset ALLE `r2:*`-Einträge – inklusive der eben gesetzten.
 * Bei `probe.ok && deviation.length > 0` (state 'degraded') erschien die
 * Abweichungs-Warnung deshalb bei jedem TTL-Ablauf (Default 60 s) erneut.
 *
 * Vertrag jetzt: Der Reset gilt nur den Fehler-Klassen; die Zustands-Drosselung
 * (Deviation) wird separat gehalten.
 */
describe('DA-2026-10-17-002 – Recovery-Reset schont die Deviation-Drosselung', () => {
  it('Reset löscht nur Fehler-Klassen, nicht r2:deviation/r2:ignored-keys/r2:degraded', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(logR2Once('r2:signature-mismatch', 'sig')).toBe(true);
      expect(logR2Once('r2:timeout', 'timeout')).toBe(true);
      expect(logR2Once('r2:deviation', 'dev')).toBe(true);
      expect(logR2Once('r2:ignored-keys', 'ign', 'warn')).toBe(true);
      expect(logR2Once('r2:degraded', 'deg', 'warn')).toBe(true);

      const cleared = resetR2ErrorThrottle();
      expect(cleared.sort()).toEqual(['r2:signature-mismatch', 'r2:timeout']);

      // Fehlerklassen sind wieder „frisch“ (ein neuer Ausfall loggt erneut) …
      expect(logR2Once('r2:signature-mismatch', 'sig-2')).toBe(true);
      // … die Zustands-Drosselung lebt weiter (keine zweite Warnung).
      expect(logR2Once('r2:deviation', 'dev-2')).toBe(false);
      expect(logR2Once('r2:ignored-keys', 'ign-2', 'warn')).toBe(false);
      expect(logR2Once('r2:degraded', 'deg-2', 'warn')).toBe(false);
      expect(isR2StateThrottleSignature('r2:deviation')).toBe(true);
      expect(isR2StateThrottleSignature('r2:ignored-keys')).toBe(true);
      expect(isR2StateThrottleSignature('r2:degraded')).toBe(true);
      expect(isR2StateThrottleSignature('r2:signature-mismatch')).toBe(false);
      expect(suppressedR2LogCount('r2:deviation')).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('erfolgreiche Probe mit widersprüchlichen Quellen loggt die Abweichung genau EINMAL (kein TTL-Flood)', async () => {
    const stub = await startStub();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.R2_HEALTH_TTL_MS = '0';
    try {
      // Zwei gesetzte Access-Keys mit unterschiedlichem Wert → deviation.
      const env = envFor(stub.base, { CFR2_ACCESS_KEY_ID: OTHER_ACCESS_KEY });
      for (let run = 0; run < 3; run += 1) {
        const snapshot = await runR2HealthCheck({ env, force: true });
        expect(snapshot.state).toBe('degraded');
        expect(snapshot.problem).toBeNull();
        expect(snapshot.credentials.deviationCount).toBe(1);
      }

      const deviationLogs = errorSpy.mock.calls.filter((call) => String(call[0]).includes('R2-KONFIGURATIONSFEHLER'));
      const degradedLogs = warnSpy.mock.calls.filter((call) => String(call[0]).includes('widersprüchlich'));
      expect(deviationLogs).toHaveLength(1);
      expect(degradedLogs).toHaveLength(1);
      expect(suppressedR2LogCount('r2:deviation')).toBe(2);
      expect(suppressedR2LogCount('r2:degraded')).toBe(2);
      expect(stub.state.putCount).toBe(3);
    } finally {
      delete process.env.R2_HEALTH_TTL_MS;
      vi.restoreAllMocks();
      await stub.close();
    }
  });

  it('Recovery nach Signaturfehler setzt die Fehler-Drosselung zurück, behält aber die Deviation-Drosselung', async () => {
    const failing = await startStub({ put: 'signature' });
    const healthy = await startStub();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.R2_HEALTH_TTL_MS = '0';
    try {
      const envForBase = (base: string) => envFor(base, { CFR2_ACCESS_KEY_ID: OTHER_ACCESS_KEY });

      const broken = await runR2HealthCheck({ env: envForBase(failing.base), force: true });
      expect(broken.state).toBe('error');
      expect(broken.problem).toBe('signature-mismatch');
      // Zweiter Fehllauf: die Warnung wird unterdrückt (Drosselung greift).
      await runR2HealthCheck({ env: envForBase(failing.base), force: true });
      expect(suppressedR2LogCount('r2:signature-mismatch')).toBe(1);

      // Erholung: Schreibprobe ok, Konfiguration bleibt widersprüchlich.
      const recovered = await runR2HealthCheck({ env: envForBase(healthy.base), force: true });
      expect(recovered.state).toBe('degraded');

      // Fehler-Drosselung wurde zurückgesetzt (neuer Ausfall loggt wieder) …
      expect(suppressedR2LogCount('r2:signature-mismatch')).toBe(0);
      // … die Deviation-Warnung wurde NICHT doppelt geloggt.
      const deviationLogs = errorSpy.mock.calls.filter((call) => String(call[0]).includes('R2-KONFIGURATIONSFEHLER'));
      expect(deviationLogs).toHaveLength(1);
      // Drei Läufe, eine Warnung: die Drosselung hat beide Wiederholungen geschluckt.
      expect(suppressedR2LogCount('r2:deviation')).toBe(2);
    } finally {
      delete process.env.R2_HEALTH_TTL_MS;
      vi.restoreAllMocks();
      await failing.close();
      await healthy.close();
    }
  });
});
