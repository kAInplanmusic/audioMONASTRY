/**
 * PROD-P1-F4 · Portal-Worker: Commit-Paritaet (Staleness-Gate)
 * ============================================================
 * Anlass (real gemessen am 2026-09-20): app-1 lief auf einem Image vom 18.09.,
 * das Repo stand auf `ae5e749` (20.09.). `/api/health` nannte nur eine Version,
 * die sich nicht mit jedem Commit aendert - der Wake hielt die Flotte trotzdem
 * fuer "ready" und das Studio bekam einen zwei Tage alten Stand.
 *
 * Der Test haelt fest, was das Gate im Worker tut:
 *   1. die VergleichsREGEL - und dass sie mit server/buildInfo.ts wortgleich
 *      antwortet (der Worker kann kein TypeScript importieren, deshalb liegt die
 *      Regel zweimal im Repo);
 *   2. /api/status meldet eine belegte Abweichung als state 'stale' (KEIN ready),
 *      mit Klartextmeldung; ohne Erwartung bleibt alles wie vorher (F1-Verhalten:
 *      ready bei JSON 200 + status:ok);
 *   3. "nicht pruefbar" (Image ohne commit-Feld) blockiert NICHT;
 *   4. /api/wake prueft den SNAPSHOT-Stand (was bootet gleich) und meldet
 *      veraltete Rollen laut;
 *   5. allowStale (Body/Query bzw. Worker-Variable ALLOW_STALE) laesst bewusst
 *      durch - die Meldung bleibt sichtbar.
 * Kein Test kontaktiert das Internet: `fetch` ist vollstaendig gemockt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Cloudflare-Worker ist plain JS (ESM) – Typen sind hier nicht nötig.
import portalWorker, { commitParity, normalizeCommit, sameCommit } from '../services/portal-worker/src/index.js';
import { compareCommits } from '../server/buildInfo';

const worker = portalWorker as unknown as {
  fetch: (request: Request, env: Record<string, unknown>) => Promise<Response>;
};

const REPO_COMMIT = 'ae5e749';
const LONG_REPO_COMMIT = 'ae5e7491234567890abcdef1234567890abcdef12';

const APP_SERVER = {
  id: 1,
  name: 'audiomonastry-app-1',
  status: 'running',
  labels: { role: 'app', app: 'audioMONASTRY', 'managed-by': 'portal-worker' },
  public_net: { ipv4: { ip: '1.2.3.4' } },
};

function createEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
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
    CLOUDFLARE_API_TOKEN: 'cf-token',
    ...extra,
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
  /** /api/health-Antwort der App (Default: 200 + status ok mit Repo-Commit). */
  health?: () => Response;
  /** Flotten-Server im Status-Pfad (Default: nur app-1 laeuft). */
  servers?: unknown[];
  /** Snapshot-Images fuer den Wake (Default: keine → Kaltstart). */
  images?: unknown[];
}

function setupFetchMock(opts: FetchMockOptions = {}) {
  const serverPayloads: Record<string, unknown>[] = [];
  let serverGetCount = 0;

  const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';

    if (url.hostname === 'api.cloudflare.com') {
      if (url.pathname === '/client/v4/ips') {
        return Response.json({ result: { ipv4_cidrs: ['1.2.3.0/24'], ipv6_cidrs: [] } });
      }
      if (url.pathname === '/client/v4/zones') {
        return Response.json({ result: [{ id: 'zone-1', name: 'anunnakitools.de' }] });
      }
      if (/^\/client\/v4\/zones\/[^/]+\/dns_records/.test(url.pathname)) {
        if (method === 'PATCH') return Response.json({ success: true, result: { id: 'rec-1' } });
        return Response.json({ result: [{ id: 'rec-1', type: 'A', name: 'origin.anunnakitools.de', content: '9.9.9.9' }] });
      }
      return Response.json({ result: {} });
    }

    // Health der App ueber die Domain (der Worker nutzt resolveOverride auf origin).
    if (url.hostname === 'anunnakitools.de' && url.pathname === '/api/health') {
      if (opts.health) return opts.health();
      return Response.json({ status: 'ok', version: '1.210.001', commit: REPO_COMMIT, buildTime: '2026-09-20T15:04:05Z' });
    }

    const path = url.pathname;
    if (path === '/v1/servers' && method === 'GET') {
      serverGetCount += 1;
      if (opts.servers) return Response.json({ servers: opts.servers });
      // 1. Aufruf = Existenz-Check (leer), danach liefert Hetzner die erstellte
      // app-1 (startFleet pollt darauf - sonst gibt es keine Verdrahtung).
      return Response.json({ servers: serverGetCount === 1 ? [] : [APP_SERVER] });
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
  return { fetchMock, serverPayloads };
}

async function call(url: string, env: Record<string, unknown>, init: RequestInit = {}): Promise<Response> {
  const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
  return worker.fetch(
    new Request(url, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } }),
    env,
  );
}

interface StatusBody {
  state?: string;
  stale?: boolean;
  url?: string;
  expectedCommit?: string | null;
  allowStale?: boolean;
  health?: { http?: number; version?: string; commit?: string | null; buildTime?: string | null };
  parity?: { ok?: boolean; checked?: boolean; expected?: string | null; actual?: string | null; message?: string };
}

describe('F4 · Vergleichsregel (Worker == Server == Shell)', () => {
  it('antwortet wortgleich zu compareCommits aus server/buildInfo.ts', () => {
    const pairs: [string, string | undefined][] = [
      [REPO_COMMIT, REPO_COMMIT],
      [REPO_COMMIT, LONG_REPO_COMMIT],
      [LONG_REPO_COMMIT, REPO_COMMIT],
      [REPO_COMMIT, 'deadbee'],
      [REPO_COMMIT, undefined],
      [REPO_COMMIT, 'unknown'],
      [REPO_COMMIT, 'none'],
      ['', REPO_COMMIT],
      ['  AE5E749  ', REPO_COMMIT],
    ];
    for (const [expected, actual] of pairs) {
      const workerVerdict = commitParity({ expected, actual });
      const serverVerdict = compareCommits(expected, actual);
      expect(
        { ok: workerVerdict.ok, checked: workerVerdict.checked, expected: workerVerdict.expected, actual: workerVerdict.actual },
        `Abweichung fuer erwartet=${expected} gemeldet=${actual}`,
      ).toEqual({
        ok: serverVerdict.ok,
        checked: serverVerdict.checked,
        expected: serverVerdict.expected,
        actual: serverVerdict.actual,
      });
    }
  });

  it('gleicher Commit, kurzer trifft langen, abweichender ist eine Abweichung', () => {
    expect(commitParity({ expected: REPO_COMMIT, actual: REPO_COMMIT })).toMatchObject({ ok: true, checked: true });
    expect(sameCommit(REPO_COMMIT, LONG_REPO_COMMIT)).toBe(true);
    expect(sameCommit(LONG_REPO_COMMIT, REPO_COMMIT)).toBe(true);
    expect(sameCommit(REPO_COMMIT, 'ae5e750')).toBe(false);
    const stale = commitParity({ expected: REPO_COMMIT, actual: 'deadbee' });
    expect(stale).toMatchObject({ ok: false, checked: true });
    expect(stale.message).toBe('Flotte laeuft Stand deadbee, Repo ist ae5e749.');
  });

  it('fehlender Commit ist "nicht pruefbar" - kein Fehlalarm', () => {
    expect(normalizeCommit('unknown')).toBe('');
    expect(normalizeCommit('dev')).toBe('');
    const parity = commitParity({ expected: REPO_COMMIT, actual: null, source: 'health' });
    expect(parity).toMatchObject({ ok: true, checked: false, actual: null });
    expect(parity.message).toContain('nicht pruefbar');
  });
});

describe('F4 · /api/status: "stale" statt "ready" bei belegter Abweichung', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bleibt ohne Erwartung wie bisher "ready" (F1-Verhalten unveraendert)', async () => {
    setupFetchMock({ servers: [APP_SERVER] });

    const res = await call('https://anunnakitools.de/api/status', createEnv());
    const body = (await res.json()) as StatusBody;

    expect(res.status).toBe(200);
    expect(body.state).toBe('ready');
    expect(body.health?.http).toBe(200);
    expect(body.parity?.checked).toBe(false);
    expect(body.parity?.message).toContain('Kein erwarteter Commit gesetzt');
  });

  it('meldet den alten Knoten-Stand als state "stale" mit Klartext', async () => {
    setupFetchMock({
      servers: [APP_SERVER],
      health: () => Response.json({ status: 'ok', version: '1.210.001', commit: 'deadbee', buildTime: '2026-09-18T17:09:00Z' }),
    });

    const res = await call(`https://anunnakitools.de/api/status?expected=${REPO_COMMIT}`, createEnv());
    const body = (await res.json()) as StatusBody;

    expect(body.state).toBe('stale');
    expect(body.stale).toBe(true);
    expect(body.parity?.checked).toBe(true);
    expect(body.parity?.ok).toBe(false);
    expect(body.parity?.message).toBe('Flotte laeuft Stand deadbee, Repo ist ae5e749.');
    expect(body.expectedCommit).toBe(REPO_COMMIT);
    // Der Knoten meldet seinen Stand mit - der Betreiber sieht beide Seiten.
    expect(body.health?.commit).toBe('deadbee');
    expect(body.health?.buildTime).toBe('2026-09-18T17:09:00Z');
  });

  it('weiterleiten nur mit allowStale - und dann sichtbar markiert', async () => {
    setupFetchMock({
      servers: [APP_SERVER],
      health: () => Response.json({ status: 'ok', commit: 'deadbee' }),
    });

    const res = await call(`https://anunnakitools.de/api/status?expected=${REPO_COMMIT}&allowStale=1`, createEnv());
    const body = (await res.json()) as StatusBody;

    expect(body.state).toBe('ready');
    expect(body.stale).toBe(true);
    expect(body.allowStale).toBe(true);
    expect(body.parity?.message).toBe('Flotte laeuft Stand deadbee, Repo ist ae5e749.');
  });

  it('kurzer SHA gegen langen SHA im Health ist Paritaet', async () => {
    setupFetchMock({ servers: [APP_SERVER], health: () => Response.json({ status: 'ok', commit: LONG_REPO_COMMIT }) });

    const res = await call(`https://anunnakitools.de/api/status?expected=${REPO_COMMIT}`, createEnv());
    const body = (await res.json()) as StatusBody;

    expect(body.state).toBe('ready');
    expect(body.stale).toBe(false);
    expect(body.parity?.checked).toBe(true);
  });

  it('Image ohne commit-Feld blockiert nicht, wird aber gemeldet', async () => {
    setupFetchMock({ servers: [APP_SERVER], health: () => Response.json({ status: 'ok', version: '1.210.001' }) });

    const res = await call(`https://anunnakitools.de/api/status?expected=${REPO_COMMIT}`, createEnv());
    const body = (await res.json()) as StatusBody;

    expect(body.state).toBe('ready');
    expect(body.parity?.checked).toBe(false);
    expect(body.parity?.message).toContain('nicht pruefbar');
  });

  it('die Worker-Variable EXPECTED_COMMIT pinnt den erwarteten Stand', async () => {
    setupFetchMock({ servers: [APP_SERVER], health: () => Response.json({ status: 'ok', commit: 'deadbee' }) });

    const res = await call('https://anunnakitools.de/api/status', createEnv({ EXPECTED_COMMIT: REPO_COMMIT }));
    const body = (await res.json()) as StatusBody;

    expect(body.state).toBe('stale');
    expect(body.parity?.expected).toBe(REPO_COMMIT);
  });

  it('die Worker-Variable ALLOW_STALE hebt die Blockade bewusst auf', async () => {
    setupFetchMock({ servers: [APP_SERVER], health: () => Response.json({ status: 'ok', commit: 'deadbee' }) });

    const res = await call('https://anunnakitools.de/api/status', createEnv({ EXPECTED_COMMIT: REPO_COMMIT, ALLOW_STALE: '1' }));
    const body = (await res.json()) as StatusBody;

    expect(body.state).toBe('ready');
    expect(body.stale).toBe(true);
  });
});

describe('F4 · /api/wake: Snapshot-Stand gegen Repo-Stand', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const snapshotFor = (role: string, commit: string | null) => ({
    id: 200 + role.length,
    name: `audiomonastry-snapshot-${role}`,
    description: `audiomonastry-snapshot-${role}`,
    status: 'available',
    created: '2026-09-20T10:00:00+00:00',
    labels: commit ? { role, commit } : { role },
  });

  it('meldet einen veralteten app-Snapshot laut (startet aber, der Betreiber entscheidet)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupFetchMock({
      images: ['app', 'sfu', 'ai', 'master', 'edge'].map((role) => snapshotFor(role, 'deadbee')),
    });

    const res = await call('https://anunnakitools.de/api/wake', createEnv(), {
      method: 'POST',
      body: JSON.stringify({ expectedCommit: REPO_COMMIT }),
    });
    const body = (await res.json()) as {
      started?: boolean;
      expectedCommit?: string;
      allowStale?: boolean;
      parity?: { ok?: boolean; checked?: boolean; source?: string; message?: string };
      staleRoles?: string[];
      usedSnapshots?: Record<string, { commit?: string | null }>;
    };

    expect(res.status).toBe(200);
    expect(body.started).toBe(true);
    expect(body.parity).toMatchObject({ ok: false, checked: true, source: 'snapshot' });
    expect(body.parity?.message).toBe('Flotte laeuft Stand deadbee, Repo ist ae5e749.');
    expect(body.expectedCommit).toBe(REPO_COMMIT);
    expect(body.usedSnapshots?.app?.commit).toBe('deadbee');
    expect(body.staleRoles).toContain('app:deadbee');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('passender Snapshot (kurz vs. lang) ist Paritaet', async () => {
    setupFetchMock({
      images: ['app', 'sfu', 'ai', 'master', 'edge'].map((role) => snapshotFor(role, LONG_REPO_COMMIT)),
    });

    const res = await call('https://anunnakitools.de/api/wake', createEnv(), {
      method: 'POST',
      body: JSON.stringify({ expectedCommit: REPO_COMMIT }),
    });
    const body = (await res.json()) as { parity?: { ok?: boolean; checked?: boolean }; staleRoles?: string[] };

    expect(body.parity).toMatchObject({ ok: true, checked: true });
    expect(body.staleRoles).toEqual([]);
  });

  it('Snapshot ohne Commit-Label ist "nicht pruefbar" - kein Fehlalarm', async () => {
    setupFetchMock({ images: ['app', 'sfu', 'ai', 'master', 'edge'].map((role) => snapshotFor(role, null)) });

    const res = await call('https://anunnakitools.de/api/wake', createEnv(), {
      method: 'POST',
      body: JSON.stringify({ expectedCommit: REPO_COMMIT }),
    });
    const body = (await res.json()) as { parity?: { checked?: boolean; message?: string }; staleRoles?: string[] };

    expect(body.parity?.checked).toBe(false);
    expect(body.parity?.message).toContain('nicht pruefbar');
    expect(body.staleRoles).toEqual([]);
  });

  it('Kaltstart ohne Snapshot behauptet keine Paritaet', async () => {
    setupFetchMock({ images: [] });

    const res = await call('https://anunnakitools.de/api/wake', createEnv(), {
      method: 'POST',
      body: JSON.stringify({ expectedCommit: REPO_COMMIT }),
    });
    const body = (await res.json()) as { parity?: { checked?: boolean; source?: string } };

    expect(body.parity?.checked).toBe(false);
    expect(body.parity?.source).toBe('snapshot');
  });

  it('allowStale im Wake-Body wird als bewusste Freigabe zurueckgemeldet', async () => {
    setupFetchMock({ images: ['app', 'sfu', 'ai', 'master', 'edge'].map((role) => snapshotFor(role, 'deadbee')) });

    const res = await call('https://anunnakitools.de/api/wake', createEnv(), {
      method: 'POST',
      body: JSON.stringify({ expectedCommit: REPO_COMMIT, allowStale: 1 }),
    });
    const body = (await res.json()) as { allowStale?: boolean; parity?: { allowStale?: boolean; ok?: boolean } };

    expect(body.allowStale).toBe(true);
    expect(body.parity?.allowStale).toBe(true);
    expect(body.parity?.ok).toBe(false);
  });

  it('ohne erwarteten Commit bleibt der Wake wie vorher (nur mit Zusatzfeldern)', async () => {
    setupFetchMock({ images: [] });

    const res = await call('https://anunnakitools.de/api/wake', createEnv(), { method: 'POST' });
    const body = (await res.json()) as { started?: boolean; expectedCommit?: string | null; parity?: { checked?: boolean } };

    expect(body.started).toBe(true);
    expect(body.expectedCommit).toBeNull();
    expect(body.parity?.checked).toBe(false);
  });
});
