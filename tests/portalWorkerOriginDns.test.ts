/**
 * F1 · Origin-Verdrahtung des Portal-Workers: Fehler sind sichtbar, "ready" nur
 * bei JSON 200.
 * =====================================================================
 * LIVE-BEFUND 2026-09-20: https://anunnakitools.de lieferte HTTP 522. Ursachen:
 * der Cloudflare-Token des Workers antwortete mit `9109 Invalid access token`
 * (die DNS-Verdrahtung des origin-Records blieb aus) und der Health-Check des
 * Status hielt JEDE 2xx-Antwort fuer "bereit" - auch die HTML-Seite der
 * Worker-Route. Diese Tests halten die Korrekturen fest:
 *   1. syncOriginDns() liefert Klartextgruende (Cloudflare-Code + Message +
 *      Betreiberhinweis) statt "Cloudflare-Zone nicht gefunden";
 *   2. /api/wake, /api/wire-fleet und /api/status geben den Grund zurueck;
 *   3. "ready" verlangt HTTP 200 UND JSON mit status:"ok";
 *   4. die Rolle app installiert beim Kaltstart Caddyfile.origin (kein ACME-
 *      Default) und legt die Zertifikate mit Rechten 600 ab.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Cloudflare-Worker ist plain JS (ESM) – Typen sind hier nicht nötig.
import portalWorker from '../services/portal-worker/src/index.js';

const worker = portalWorker as unknown as {
  fetch: (request: Request, env: Record<string, unknown>) => Promise<Response>;
};

const FLEET_ROLES = ['app', 'sfu', 'ai', 'master', 'edge'];
const FLEET_SERVERS = FLEET_ROLES.map((role, i) => ({
  id: i + 1,
  name: `audiomonastry-${role}-1`,
  status: 'running',
  labels: { role, app: 'audioMONASTRY', 'managed-by': 'portal-worker' },
  public_net: role === 'app' ? { ipv4: { ip: '142.132.229.71' } } : null,
}));
const APP_IP = '142.132.229.71';
/** Die Cloudflare-Antwort, die der Live-Befund geliefert hat. */
const CF_INVALID_TOKEN = {
  success: false,
  errors: [{ code: 9109, message: 'Invalid access token' }],
  messages: [],
  result: null,
};

function createEnv(): Record<string, unknown> {
  return {
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'geheim',
    SESSION_SECRET: 'session-secret',
    HCLOUD_TOKEN: 'hcloud-token',
    STUDIO_ACCESS_TOKEN: 'studio-token',
    SSH_PUBLIC_KEY: '',
    GITHUB_TOKEN: '',
    ORIGIN_CERT: '',
    ORIGIN_KEY: '',
    APP_DOMAIN: 'anunnakitools.de',
    CLOUDFLARE_API_TOKEN: 'cf-token',
  };
}

async function makeSessionCookie(secret: string, user = 'admin'): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = `${user}.${exp}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `portal=${encodeURIComponent(`${payload}.${hex}`)}`;
}

interface FetchMockOptions {
  /** Cloudflare liefert 9109 Invalid access token (Live-Fall). */
  cloudflareInvalidToken?: boolean;
  /** Antwort auf GET /zones (Default: Zone vorhanden). */
  zones?: unknown[];
  /** origin-DNS-Record (Default: A-Record auf eine ALTE IP, DNS-only). */
  originRecord?: Record<string, unknown> | null;
  /** /api/health-Antwort der App (Default: gar nicht, wirft). */
  health?: () => Response;
  servers?: unknown[];
  images?: unknown[];
}

function setupFetchMock(opts: FetchMockOptions = {}) {
  const cfRequests: { method: string; path: string; body?: string }[] = [];
  const serverPayloads: Record<string, unknown>[] = [];
  const healthCalls: { url: string; resolveOverride?: string }[] = [];
  // 1. GET /v1/servers = Existenz-Check (leer), danach liefert Hetzner die
  // erstellte app-1 (startFleet pollt darauf) - sonst bricht startFleet mit
  // "Flotte existiert bereits" ab und die Verdrahtung wird nie erreicht.
  let serverGetCount = 0;
  const wokenFleet = [{ ...FLEET_SERVERS[0] }];

  const fetchMock = vi.fn(async (input: unknown, init: RequestInit & { cf?: { resolveOverride?: string } } = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';

    if (url.hostname === 'api.cloudflare.com') {
      cfRequests.push({ method, path: url.pathname + url.search, body: init.body ? String(init.body) : undefined });
      if (opts.cloudflareInvalidToken) return Response.json(CF_INVALID_TOKEN, { status: 403 });
      if (url.pathname === '/client/v4/ips') {
        return Response.json({ success: true, result: { ipv4_cidrs: ['1.2.3.0/24'], ipv6_cidrs: [] } });
      }
      if (url.pathname === '/client/v4/zones') {
        return Response.json({ success: true, result: opts.zones ?? [{ id: 'zone-1', name: 'anunnakitools.de' }] });
      }
      if (/^\/client\/v4\/zones\/[^/]+\/dns_records/.test(url.pathname)) {
        if (method === 'PATCH') return Response.json({ success: true, result: { id: 'rec-1' } });
        const record = opts.originRecord === undefined
          ? { id: 'rec-1', type: 'A', name: 'origin.anunnakitools.de', content: '104.16.0.1', proxied: false }
          : opts.originRecord;
        return Response.json({ success: true, result: record ? [record] : [] });
      }
      return Response.json({ success: true, result: {} });
    }

    // App-Health ueber die Domain (der Worker nutzt resolveOverride auf origin).
    if (url.hostname === 'anunnakitools.de' && url.pathname === '/api/health') {
      healthCalls.push({ url: String(input), resolveOverride: init.cf?.resolveOverride });
      if (!opts.health) throw new Error('timeout');
      return opts.health();
    }

    const path = url.pathname;
    if (path === '/v1/servers' && method === 'GET') {
      serverGetCount += 1;
      if (opts.servers) return Response.json({ servers: opts.servers });
      return Response.json({ servers: serverGetCount === 1 ? [] : wokenFleet });
    }
    if (path === '/v1/servers' && method === 'POST') {
      const payload = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      serverPayloads.push(payload);
      return Response.json({ server: { id: serverPayloads.length, name: payload.name } });
    }
    if (path === '/v1/images' && method === 'GET') return Response.json({ images: opts.images ?? [] });
    if (path === '/v1/firewalls' && method === 'GET') {
      return Response.json({ firewalls: [{ id: 7, name: 'audiomonastry-app', rules: [], applied_to: [] }] });
    }
    if (path === '/v1/firewalls' && method === 'POST') return Response.json({ firewall: { id: 7 } });
    return Response.json({ actions: [{ id: 1, status: 'success' }] });
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, cfRequests, serverPayloads, healthCalls };
}

async function call(url: string, env: Record<string, unknown>, init: RequestInit = {}) {
  const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
  return worker.fetch(new Request(url, { ...init, headers: { cookie, ...(init.headers ?? {}) } }), env);
}

describe('F1 · Cloudflare-DNS-Fehler im Klartext (Portal-Worker)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('nennt im Wake-Ergebnis den echten Grund statt "Zone nicht gefunden"', async () => {
    setupFetchMock({ cloudflareInvalidToken: true, images: [] });

    const env = createEnv();
    const res = await call('https://anunnakitools.de/api/wake', env, { method: 'POST' });
    const body = (await res.json()) as {
      wiring?: { ok?: boolean; message?: string; dns?: { ok?: boolean; code?: string; message?: string; hint?: string } };
    };

    expect(res.status).toBe(200);
    // Der Start selbst klappt, die Verdrahtung nicht - und beides ist sichtbar.
    expect(body.wiring?.dns?.ok).toBe(false);
    expect(body.wiring?.dns?.code).toBe('cloudflare-error');
    expect(String(body.wiring?.dns?.message ?? '')).toContain('9109');
    expect(String(body.wiring?.dns?.message ?? '')).toContain('Invalid access token');
    expect(String(body.wiring?.dns?.hint ?? '')).toContain('Zone:DNS:Edit');
    expect(body.wiring?.ok).toBe(false);
    expect(String(body.wiring?.message ?? '')).toContain('origin-DNS');
  });

  it('nennt im wire-fleet-Ergebnis denselben Klartextgrund', async () => {
    setupFetchMock({ servers: FLEET_SERVERS, cloudflareInvalidToken: true });

    const res = await call('https://anunnakitools.de/api/wire-fleet', createEnv(), { method: 'POST' });
    const body = (await res.json()) as { ok?: boolean; message?: string; dns?: { ok?: boolean; message?: string } };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(String(body.message ?? '')).toContain('Flotten-Verdrahtung unvollstaendig');
    expect(String(body.dns?.message ?? '')).toContain('9109');
  });

  it('meldet einen fehlenden Cloudflare-Token als eigenen Grund (code token-missing)', async () => {
    setupFetchMock({ servers: FLEET_SERVERS });

    const env = createEnv();
    delete env.CLOUDFLARE_API_TOKEN;
    const res = await call('https://anunnakitools.de/api/wire-fleet', env, { method: 'POST' });
    const body = (await res.json()) as { dns?: { ok?: boolean; code?: string; message?: string } };

    expect(body.dns?.ok).toBe(false);
    expect(body.dns?.code).toBe('token-missing');
    expect(String(body.dns?.message ?? '')).toContain('CLOUDFLARE_API_TOKEN');
  });

  it('schreibt proxied=false mit, wenn der origin-Record proxied ist (522-Pfad)', async () => {
    const { cfRequests } = setupFetchMock({
      servers: FLEET_SERVERS,
      originRecord: { id: 'rec-1', type: 'A', name: 'origin.anunnakitools.de', content: APP_IP, proxied: true },
    });

    const res = await call('https://anunnakitools.de/api/wire-fleet', createEnv(), { method: 'POST' });
    const body = (await res.json()) as { dns?: { ok?: boolean; changed?: boolean } };

    expect(body.dns?.ok).toBe(true);
    expect(body.dns?.changed).toBe(true);
    const patch = cfRequests.find((r) => r.method === 'PATCH');
    expect(patch, 'kein PATCH auf den origin-Record').toBeTruthy();
    expect(JSON.parse(String(patch?.body))).toEqual({ content: APP_IP, proxied: false });
  });
});

describe('F1 · /api/status: "ready" nur bei JSON 200', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('meldet NICHT ready, wenn /api/health HTML mit 200 liefert (Worker-Route)', async () => {
    setupFetchMock({
      servers: FLEET_SERVERS,
      health: () => new Response('<!doctype html><html><body>Fehler</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    });

    const res = await call('https://anunnakitools.de/api/status', createEnv());
    const body = (await res.json()) as {
      state?: string;
      healthError?: string;
      dns?: { ok?: boolean; message?: string };
      wiringError?: string | null;
    };

    expect(res.status).toBe(200);
    expect(body.state).toBe('starting-app');
    expect(String(body.healthError ?? '')).toContain('kein JSON');
    // Der falsch verdrahtete origin-Record (alte Cloudflare-IP) wird als Grund
    // mitgeliefert - die Diagnose selbst schreibt nichts.
    expect(body.dns?.ok).toBe(false);
    expect(String(body.dns?.message ?? '')).toContain('104.16.0.1');
    expect(String(body.wiringError ?? '')).toContain('origin-DNS falsch verdrahtet');
  });

  it('meldet NICHT ready bei Timeout/522 und nennt den Grund', async () => {
    setupFetchMock({ servers: FLEET_SERVERS }); // kein health-Handler -> fetch wirft (Timeout)

    const res = await call('https://anunnakitools.de/api/status', createEnv());
    const body = (await res.json()) as { state?: string; healthError?: string };

    expect(body.state).toBe('starting-app');
    expect(String(body.healthError ?? '')).toContain('keine Antwort');
  });

  it('meldet ready bei JSON 200 mit status:ok - und diagnostiziert dann kein DNS', async () => {
    const { cfRequests } = setupFetchMock({
      servers: FLEET_SERVERS,
      health: () => Response.json({ status: 'ok', version: '1.210.001' }),
      originRecord: { id: 'rec-1', type: 'A', name: 'origin.anunnakitools.de', content: APP_IP, proxied: false },
    });

    const res = await call('https://anunnakitools.de/api/status', createEnv());
    const body = (await res.json()) as { state?: string; url?: string; health?: { http?: number; version?: string } };

    expect(body.state).toBe('ready');
    expect(body.url).toBe('/');
    expect(body.health?.http).toBe(200);
    expect(body.health?.version).toBe('1.210.001');
    // Bereit heisst: kein zusaetzlicher Cloudflare-Aufruf im Poll (Kosten/Latenz).
    expect(cfRequests).toHaveLength(0);
  });

  it('diagnostiziert schreibfrei: die Status-Route setzt keinen PATCH ab', async () => {
    const { cfRequests } = setupFetchMock({
      servers: FLEET_SERVERS,
      health: () => Response.json({ status: 'starting', version: 'dev' }),
    });

    await call('https://anunnakitools.de/api/status', createEnv());

    expect(cfRequests.some((r) => r.method === 'PATCH')).toBe(false);
  });
});

describe('F1 · Cloud-Init der Rolle app: Caddyfile.origin + Zertifikate (600)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('installiert Caddyfile.origin unabhängig von den Zertifikats-Secrets', async () => {
    const { serverPayloads } = setupFetchMock({ images: [] });

    await call('https://anunnakitools.de/api/wake', createEnv(), { method: 'POST' });

    const appPayload = serverPayloads.find((p) => p.name === 'audiomonastry-app-1');
    const userData = String(appPayload?.user_data ?? '');
    expect(userData).not.toBe('');

    const installIndex = userData.indexOf('cp scripts/hetzner/Caddyfile.origin Caddyfile');
    const certBranchIndex = userData.indexOf('if [ -n "${ORIGIN_CERT:-}" ]');
    expect(installIndex, 'Caddyfile.origin wird nicht installiert').toBeGreaterThan(-1);
    // Reihenfolge: die Origin-Caddyfile steht VOR der Zertifikats-Verzweigung -
    // ein fehlendes Secret darf nicht dazu fuehren, dass gar kein Caddyfile
    // (oder die ACME-Variante) auf dem Knoten landet.
    expect(certBranchIndex).toBeGreaterThan(installIndex);
    // ACME ist kein Rollen-Default mehr: die Repo-Caddyfile (ACME) wird nicht kopiert.
    expect(userData).not.toContain('cp Caddyfile /etc/caddy');
  });

  it('schreibt beide Zertifikatsdateien mit 600 und prueft sie vor dem Caddy-Start', async () => {
    const { serverPayloads } = setupFetchMock({ images: [] });

    const env = createEnv();
    env.ORIGIN_CERT = 'Q0VSVA==';
    env.ORIGIN_KEY = 'S0VZ';
    await call('https://anunnakitools.de/api/wake', env, { method: 'POST' });

    const appPayload = serverPayloads.find((p) => p.name === 'audiomonastry-app-1');
    const userData = String(appPayload?.user_data ?? '');

    expect(userData).toContain('certs/origin.crt');
    expect(userData).toContain('certs/origin.key');
    expect(userData).toContain('chmod 600 /opt/audiomonastry/certs/origin.crt /opt/audiomonastry/certs/origin.key');
    expect(userData).toContain('chmod 700 /opt/audiomonastry/certs');
    expect(userData).toContain('umask 077');
    // Pruefung VOR dem Compose-Start (Reihenfolge im Skript).
    expect(userData.indexOf('openssl x509')).toBeLessThan(userData.indexOf('docker compose -f docker-compose.hetzner.yml up -d caddy audiomonastry'));
  });

  it('meldet fehlende Zertifikats-Secrets laut (kein stiller ACME-Fallback)', async () => {
    const { serverPayloads } = setupFetchMock({ images: [] });

    await call('https://anunnakitools.de/api/wake', createEnv(), { method: 'POST' });

    const userData = String(serverPayloads.find((p) => p.name === 'audiomonastry-app-1')?.user_data ?? '');
    expect(userData).toContain('ORIGIN_CERT/ORIGIN_KEY fehlen im Portal-Secret');
    expect(userData).toContain('docs/ORIGIN_TLS_DNS_RUNBOOK.md');
  });
});
