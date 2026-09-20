/**
 * FIX F2 · Integrationstest der Cloud-/Autosave-Routen gegen einen R2-Stub
 * =======================================================================
 * Geprüft wird die ganze Kette über die echten Routen (`../server`):
 *
 *   GET  /api/cloud/health    (i) gültige Probe, (ii) SignatureDoesNotMatch,
 *                             (iii) fehlende Credentials, (iv) widersprüchliche
 *                             Quellen  → je Zustand + Grund im JSON
 *   GET  /api/metrics         → cloud.r2 / cloud.writes sichtbar (F2/b+c)
 *   POST /api/session/autosave→ begrenzte Retries mit Backoff, EINE Warnung,
 *                               `degraded` + `reason` statt stiller 502
 *
 * Der R2-Endpoint ist ein lokaler Stub (`127.0.0.1`) – kein Cloudflare-Zugriff,
 * keine echten Credentials. Die Signaturprüfung von R2 selbst kann offline nicht
 * nachgestellt werden; der Stub antwortet mit der Original-XML von R2.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const ACCESS_KEY = 'a'.repeat(32);
const SECRET_KEY = 'b'.repeat(64);
const BUCKET = 'audiomonastrysamples';

let appServer: Server;
let r2Stub: Server;
let baseUrl = '';
let stubBase = '';
let putCount = 0;
let deleteCount = 0;
const authorizations: string[] = [];
/** Steuerung der Stub-Antwort je Testfall. */
let putMode: 'ok' | 'signature' | 'server-error' = 'ok';

const AUTOSAVE_ENVELOPE = {
  schemaVersion: 2,
  revision: 1,
  idempotencyKey: 'rev-f2-1',
  savedAt: 1_000,
  payload: { moduleStates: { eq: 'AUTO_AI' }, bpm: 128 },
};

async function postAutosave(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/session/autosave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(AUTOSAVE_ENVELOPE),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  process.env.VITEST = 'true';
  delete process.env.STUDIO_ACCESS_TOKEN;
  // Dieses Testfile macht mehr als 60 Requests; das allgemeine Limit bleibt
  // konfigurierbar (wie in tests/aiRoutes.test.ts) statt die Aussage zu verzerren.
  process.env.API_RATE_LIMIT_MAX = '1000';
  // Kein Cloudflare, kein echter Bucket: alles gegen den lokalen Stub.
  r2Stub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      authorizations.push(String(req.headers.authorization ?? ''));
      if (req.method === 'PUT') {
        putCount += 1;
        if (putMode === 'signature') {
          res.writeHead(403, { 'Content-Type': 'application/xml' });
          res.end(
            '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code>'
            + '<Message>The request signature we calculated does not match the signature you provided.</Message></Error>',
          );
          return;
        }
        if (putMode === 'server-error') {
          res.writeHead(503, { 'Content-Type': 'application/xml' });
          res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>ServiceUnavailable</Code><Message>try later</Message></Error>');
          return;
        }
        res.writeHead(200, { ETag: '"stub"' });
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        deleteCount += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(400).end();
    });
  });
  await new Promise<void>((resolve) => r2Stub.listen(0, '127.0.0.1', resolve));
  stubBase = `http://127.0.0.1:${(r2Stub.address() as AddressInfo).port}`;

  process.env.CFS3_ENDPOINT = stubBase;
  process.env.CFS3_ACCESS_KEY = ACCESS_KEY;
  process.env.CFS3_SECRET_KEY = SECRET_KEY;
  process.env.CFS3_BUCKET = BUCKET;
  // Supabase bleibt aus (kein Netz): die Health-Antwort zeigt dann
  // 'not-configured' – geprüft wird hier ausschließlich der R2-Teil.
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE = '';
  process.env.SUPABASE_ANON_PUB = '';
  process.env.SB_URL = '';
  process.env.SB_SERVICE_ROLE = '';
  // EINE Wiederholungsschicht: nur die Route darf wiederholen (deterministische
  // Zählung am Stub), Backoff ohne Wartezeit.
  process.env.R2_SDK_MAX_ATTEMPTS = '1';
  process.env.R2_AUTOSAVE_RETRY_ATTEMPTS = '3';
  process.env.R2_AUTOSAVE_RETRY_BASE_MS = '1';
  process.env.R2_AUTOSAVE_RETRY_MAX_MS = '2';
  process.env.R2_HEALTH_TTL_MS = '0';

  const mod = await import('../server');
  appServer = mod.app.listen(0);
  baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => {
    r2Stub.closeAllConnections?.();
    r2Stub.close(() => resolve());
  });
});

describe('GET /api/cloud/health – echte R2-Schreibprobe', () => {
  it('(i) gültige Probe → ok, mit Probeobjekt und benannter Credential-Quelle', async () => {
    putMode = 'ok';
    putCount = 0;
    deleteCount = 0;
    const res = await fetch(`${baseUrl}/api/cloud/health?probe=1`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;

    expect(body.r2.status).toBe('ok');
    expect(body.r2.state).toBe('ok');
    expect(body.r2.ok).toBe(true);
    expect(body.r2.reason).toBeNull();
    expect(body.r2.bucket).toBe(BUCKET);
    expect(body.r2.probe.method).toBe('PUT+DELETE');
    expect(body.r2.probe.key).toMatch(/^probes\/r2-health-/);
    expect(body.r2.credentials.source).toContain('CFS3_ACCESS_KEY');
    expect(body.r2.credentials.deviationCount).toBe(0);
    // Echte Schreibprobe: genau ein PUT, danach aufgeräumt (DELETE).
    expect(putCount).toBe(1);
    expect(deleteCount).toBe(1);
    // Signiert wurde mit dem aufgelösten Access-Key.
    expect(authorizations.some((a) => a.includes(`Credential=${ACCESS_KEY}/`))).toBe(true);
  });

  it('(ii) SignatureDoesNotMatch → degraded + Grund, niemals ok', async () => {
    putMode = 'signature';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/api/cloud/health?probe=1`);
      expect(res.status).toBe(200); // die Route selbst antwortet
      const body = await res.json() as Record<string, any>;

      expect(body.r2.ok).toBe(false);
      expect(body.r2.state).toBe('degraded');
      expect(body.r2.problem).toBe('signature-mismatch');
      expect(body.r2.reason).toBe('signature-mismatch');
      expect(String(body.r2.status)).toMatch(/^error: /);
      expect(body.r2.hint).toContain('OPS_RUNBOOK');
      // Kein Secret in der Antwort, aber die Herkunft ist benannt.
      expect(JSON.stringify(body)).not.toContain(SECRET_KEY);
      expect(body.r2.credentials.usedEnvKeys).toContain('CFS3_ACCESS_KEY');
      expect(errorSpy).toHaveBeenCalled();
      putMode = 'ok';
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('(iii) ohne R2-Credentials → unconfigured (nie ok), ohne Netzaufruf', async () => {
    const before = putCount;
    const backup = {
      CFS3_ACCESS_KEY: process.env.CFS3_ACCESS_KEY,
      CFS3_SECRET_KEY: process.env.CFS3_SECRET_KEY,
      CFS3_BUCKET: process.env.CFS3_BUCKET,
    };
    delete process.env.CFS3_ACCESS_KEY;
    delete process.env.CFS3_SECRET_KEY;
    delete process.env.CFS3_BUCKET;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/api/cloud/health?probe=1`);
      const body = await res.json() as Record<string, any>;
      expect(body.r2.ok).toBe(false);
      expect(body.r2.state).toBe('unconfigured');
      expect(body.r2.status).toBe('not-configured');
      expect(body.r2.problem).toBe('not-configured');
      expect(body.r2.credentials.configured).toBe(false);
      expect(body.r2.credentials.problems).toContain('access-key-missing');
      expect(putCount).toBe(before); // keine Probe ohne Credentials
    } finally {
      vi.restoreAllMocks();
      for (const [key, value] of Object.entries(backup)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  it('(iv) widersprüchliche Quellen → degraded, Abweichung benannt (F2/a)', async () => {
    const earlier = process.env.CFR2_ACCESS_KEY_ID;
    process.env.CFR2_ACCESS_KEY_ID = 'c'.repeat(32);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/api/cloud/health?probe=1`);
      const body = await res.json() as Record<string, any>;
      expect(body.r2.ok).toBe(false);      // Signatur stimmt, Konfiguration nicht
      expect(body.r2.state).toBe('degraded');
      expect(body.r2.credentials.deviationCount).toBe(1);
      expect(body.r2.credentials.ignoredEnvKeys).toContain('CFR2_ACCESS_KEY_ID');
      // Der benutzte Wert bleibt die kanonische Quelle, die Abweichung ist
      // sichtbar – und es wird KEIN Secret ausgegeben.
      expect(body.r2.credentials.deviation[0].field).toBe('accessKeyId');
      expect(JSON.stringify(body)).not.toContain('c'.repeat(32));
    } finally {
      vi.restoreAllMocks();
      if (earlier === undefined) delete process.env.CFR2_ACCESS_KEY_ID;
      else process.env.CFR2_ACCESS_KEY_ID = earlier;
    }
  });
});

describe('POST /api/session/autosave – begrenzte Retries, eine Warnung (F2/c)', () => {
  it('schreibt im Normalfall genau ein Objekt und meldet ok', async () => {
    putMode = 'ok';
    putCount = 0;
    const res = await postAutosave();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.key).toBe('autosaves/rev-f2-1.json');
    expect(putCount).toBe(1);
  });

  it('wiederholt Transportfehler begrenzt mit Backoff und meldet degraded', async () => {
    putMode = 'server-error';
    putCount = 0;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postAutosave();
      expect(res.status).toBe(502);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('session-autosave-failed');
      expect(res.body.reason).toBe('http-error');
      expect(res.body.degraded).toBe(true);
      expect(res.body.retryable).toBe(true);
      expect(res.body.attempts).toBe(3); // 3 Versuche, dann Schluss
      expect(putCount).toBe(3);          // begrenzt: keine Endlosschleife

      // Zweite Anfrage in derselben Fehlerklasse: KEINE zweite Zeile.
      const again = await postAutosave();
      expect(again.status).toBe(502);
      const logged = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .filter((call) => String(call[0]).includes('[http-error]'));
      expect(logged).toHaveLength(1);
      expect(putCount).toBe(6);
    } finally {
      vi.restoreAllMocks();
      putMode = 'ok';
    }
  });

  it('wiederholt einen Signaturfehler NICHT und nennt die Ursache (statt Log-Flut)', async () => {
    putMode = 'signature';
    putCount = 0;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await postAutosave();
      expect(res.status).toBe(502);
      expect(res.body.reason).toBe('signature-mismatch');
      expect(res.body.degraded).toBe(true);
      expect(res.body.retryable).toBe(false);
      expect(res.body.attempts).toBe(1);
      expect(putCount).toBe(1); // deterministisch → kein sinnloser Retry
      expect(String(res.body.hint)).toContain('OPS_RUNBOOK');

      // 20 Wiederholungen des Clients (Live-Befund) → genau EINE Log-Zeile.
      for (let i = 0; i < 20; i += 1) await postAutosave();
      const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .filter((call) => String(call[0]).includes('[signature-mismatch]'));
      expect(logged).toHaveLength(1);
      expect(String(logged[0][0])).toContain('Wiederholen ist hier zwecklos');
      putMode = 'ok';
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('ohne R2-Konfiguration → 503 r2-not-configured (unverändertes Verhalten)', async () => {
    const backup = {
      CFS3_ACCESS_KEY: process.env.CFS3_ACCESS_KEY,
      CFS3_SECRET_KEY: process.env.CFS3_SECRET_KEY,
      CFS3_BUCKET: process.env.CFS3_BUCKET,
    };
    delete process.env.CFS3_ACCESS_KEY;
    delete process.env.CFS3_SECRET_KEY;
    delete process.env.CFS3_BUCKET;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await postAutosave();
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('r2-not-configured');
      expect(res.body.reason).toBe('not-configured');
      expect(res.body.degraded).toBe(true);
    } finally {
      vi.restoreAllMocks();
      for (const [key, value] of Object.entries(backup)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });
});

describe('GET /api/metrics – cloud.r2 und cloud.writes', () => {
  it('macht den R2-Zustand als cloud.r2 sichtbar', async () => {
    putMode = 'signature';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Erst ein fehlgeschlagener Schreibvorgang (Autosave), dann die Probe –
      // beide Zustände müssen in den Metriken stehen.
      const failed = await postAutosave();
      expect(failed.status).toBe(502);
      await fetch(`${baseUrl}/api/cloud/health?probe=1`);
      const res = await fetch(`${baseUrl}/api/metrics`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, any>;

      expect(body.cloud).toBeTruthy();
      expect(body.cloud.r2.state).toBe('degraded');
      expect(body.cloud.r2.problem).toBe('signature-mismatch');
      expect(body.cloud.r2.ok).toBe(false);
      expect(body.cloud.r2.checkedAt).toBeTypeOf('number');
      // Die Schreibpfade stehen daneben – der Autosave-Fehler ist ein
      // Betriebszustand, kein Log-Eintrag.
      expect(body.cloud.writes.autosave.lastProblem).toBe('signature-mismatch');
      expect(body.cloud.writes.autosave.failures).toBeGreaterThan(0);
      expect(body.cloud.writes.autosave.state).toBe('error');
    } finally {
      vi.restoreAllMocks();
      putMode = 'ok';
    }
  });

  it('liefert den R2-Zustand auch im Prometheus-Format', async () => {
    putMode = 'ok';
    const res = await fetch(`${baseUrl}/api/metrics?format=prometheus`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('audiomonastry_cloud_r2_ok ');
    expect(text).toMatch(/audiomonastry_cloud_r2_state\{state="[a-z]+",problem="[a-z-]+"\} 1/);
    expect(text).toContain('audiomonastry_cloud_r2_write_failures_total{path="autosave"}');
  });

  it('greift ohne R2-Konfiguration nicht auf ok zurück (Sichtbarkeitspflicht)', async () => {
    const backup = {
      CFS3_ACCESS_KEY: process.env.CFS3_ACCESS_KEY,
      CFS3_SECRET_KEY: process.env.CFS3_SECRET_KEY,
      CFS3_BUCKET: process.env.CFS3_BUCKET,
    };
    delete process.env.CFS3_ACCESS_KEY;
    delete process.env.CFS3_SECRET_KEY;
    delete process.env.CFS3_BUCKET;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fetch(`${baseUrl}/api/cloud/health?probe=1`);
      const res = await fetch(`${baseUrl}/api/metrics`);
      const body = await res.json() as Record<string, any>;
      expect(body.cloud.r2.state).toBe('unconfigured');
      expect(body.cloud.r2.status).toBe('not-configured');
      expect(body.cloud.r2.ok).toBe(false);
    } finally {
      vi.restoreAllMocks();
      for (const [key, value] of Object.entries(backup)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });
});
