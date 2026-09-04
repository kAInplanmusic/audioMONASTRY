/**
 * OPS-Snapshot: Portal-Worker-Tests für Rollen-Snapshots.
 *
 * Deckt ab:
 *  - startFleet nutzt das Rollen-Snapshot-Image (image: <snapshot-id>),
 *    kein cloud-init, wenn ein Snapshot existiert.
 *  - Fallback auf ubuntu-24.04 + user_data, wenn kein Snapshot existiert.
 *  - POST /api/refresh-snapshots erzeugt je laufendem Server einen Snapshot
 *    und löscht alte Snapshots (Auto-Retention: letzte 2 je Rolle).
 *  - Routen sind nur mit signiertem Session-Cookie nutzbar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Cloudflare-Worker ist plain JS (ESM) – Typen sind hier nicht nötig.
import portalWorker from '../services/portal-worker/src/index.js';

const worker = portalWorker as unknown as {
  fetch: (request: Request, env: Record<string, unknown>) => Promise<Response>;
};

const FLEET_ROLES = ['app', 'sfu', 'ai', 'master', 'edge'];
const FLEET_SERVERS = FLEET_ROLES.map((role, i) => ({
  id: i + 1,
  name: `samplemonk-${role}-1`,
  status: 'running',
  labels: { role, app: 'audioMONASTRY', 'managed-by': 'portal-worker' },
  public_net: role === 'app' ? { ipv4: { ip: '1.2.3.4' } } : null,
}));

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
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `portal=${encodeURIComponent(`${payload}.${hex}`)}`;
}

interface FetchMockOptions {
  images?: unknown[];
  servers?: unknown[];
  createServer?: (payload: Record<string, unknown>) => Record<string, unknown>;
  createImage?: (serverId: string, payload: Record<string, unknown>) => Record<string, unknown>;
}

function setupFetchMock(opts: FetchMockOptions = {}) {
  const serverPayloads: Record<string, unknown>[] = [];
  let serverGetCount = 0;
  const imageActions: { serverId: string; payload: Record<string, unknown> }[] = [];
  const deletedImages: string[] = [];

  const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';

    if (url.hostname === 'api.cloudflare.com') {
      return Response.json({ result: { ipv4_cidrs: ['1.2.3.0/24'], ipv6_cidrs: [] } });
    }

    const path = url.pathname;

    if (path === '/v1/servers' && method === 'GET') {
      // 1. Aufruf = Existenz-Check (leer), danach liefert Hetzner die
      // erstellte app-1 mit IP (startFleet pollt darauf).
      serverGetCount += 1;
      const servers = serverGetCount === 1
        ? (opts.servers ?? [])
        : (opts.servers && opts.servers.length > 0
            ? opts.servers
            : [{ id: 1, name: 'samplemonk-app-1', status: 'running', labels: { role: 'app' }, public_net: { ipv4: { ip: '1.2.3.4' } } }]);
      return Response.json({ servers });
    }
    if (path === '/v1/servers' && method === 'POST') {
      const payload = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      serverPayloads.push(payload);
      const created = opts.createServer?.(payload) ?? {
        server: { id: serverPayloads.length, name: payload.name },
      };
      return Response.json(created);
    }
    if (path === '/v1/images' && method === 'GET') {
      return Response.json({ images: opts.images ?? [] });
    }
    const createImageMatch = /^\/v1\/servers\/(\d+)\/actions\/create_image$/.exec(path);
    if (createImageMatch && method === 'POST') {
      const payload = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      imageActions.push({ serverId: createImageMatch[1], payload });
      const created = opts.createImage?.(createImageMatch[1], payload) ?? {
        action: { id: 1000 + imageActions.length },
      };
      return Response.json(created);
    }
    const deleteImageMatch = /^\/v1\/images\/(\d+)$/.exec(path);
    if (deleteImageMatch && method === 'DELETE') {
      deletedImages.push(deleteImageMatch[1]);
      return new Response(null, { status: 204 });
    }
    if (path === '/v1/firewalls' && method === 'GET') {
      return Response.json({ firewalls: [] });
    }
    if (path === '/v1/firewalls' && method === 'POST') {
      return Response.json({ firewall: { id: 7 } });
    }

    return Response.json({});
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, serverPayloads, imageActions, deletedImages };
}

describe('Portal-Worker OPS-Snapshot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('startFleet nutzt das Rollen-Snapshot-Image statt cloud-init', async () => {
    const images = FLEET_ROLES.map((role, i) => ({
      id: 101 + i,
      name: `samplemonk-snapshot-${role}-20260902`,
      description: `samplemonk-snapshot-${role}-2026-09-02`,
      status: 'available',
      created: '2026-09-02T10:00:00+00:00',
      labels: { app: 'audioMONASTRY', role },
    }));
    const { serverPayloads } = setupFetchMock({ images });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/wake', {
        method: 'POST',
        headers: { cookie },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      started: boolean;
      created: string[];
      usedSnapshots: Record<string, { image: number }>;
      fallbackRoles: string[];
    };
    expect(body.started).toBe(true);
    expect(body.created).toHaveLength(5);
    expect(body.fallbackRoles).toEqual([]);
    expect(Object.keys(body.usedSnapshots)).toEqual(FLEET_ROLES);

    for (const payload of serverPayloads) {
      const role = payload.labels && (payload.labels as Record<string, string>).role;
      const snapshot = images.find((img) => img.labels.role === role);
      expect(payload.image).toBe(snapshot?.id);
      expect(payload.user_data).toBeUndefined();
    }
  });

  it('startFleet fällt ohne Snapshot auf ubuntu-24.04 + cloud-init zurück', async () => {
    const { serverPayloads } = setupFetchMock({ images: [] });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/wake', {
        method: 'POST',
        headers: { cookie },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usedSnapshots: Record<string, unknown>;
      fallbackRoles: string[];
    };
    expect(body.usedSnapshots).toEqual({});
    expect(body.fallbackRoles).toEqual(FLEET_ROLES);

    for (const payload of serverPayloads) {
      expect(payload.image).toBe('ubuntu-24.04');
      expect(typeof payload.user_data).toBe('string');
      expect((payload.user_data as string).length).toBeGreaterThan(0);
    }
  });

  it('refresh-snapshots erzeugt je Rolle einen Snapshot und behält nur die letzten 2', async () => {
    const images = [
      { id: 201, name: 'samplemonk-snapshot-app-20260902', description: 'samplemonk-snapshot-app-2026-09-02', status: 'available', created: '2026-09-02T10:00:00+00:00', labels: { app: 'audioMONASTRY', role: 'app' } },
      { id: 202, name: 'samplemonk-snapshot-app-20260901', description: 'samplemonk-snapshot-app-2026-09-01', status: 'available', created: '2026-09-01T10:00:00+00:00', labels: { app: 'audioMONASTRY', role: 'app' } },
      { id: 203, name: 'samplemonk-snapshot-app-20260831', description: 'samplemonk-snapshot-app-2026-08-31', status: 'available', created: '2026-08-31T10:00:00+00:00', labels: { app: 'audioMONASTRY', role: 'app' } },
      { id: 204, name: 'samplemonk-snapshot-sfu-20260902', description: 'samplemonk-snapshot-sfu-2026-09-02', status: 'available', created: '2026-09-02T10:00:00+00:00', labels: { app: 'audioMONASTRY', role: 'sfu' } },
    ];
    const { imageActions, deletedImages } = setupFetchMock({ servers: FLEET_SERVERS, images });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/refresh-snapshots', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ commit: 'abc123def', version: '1.210.001' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      created: { role: string; description: string; action: number | null; commit: string | null; version: string | null }[];
      deleted: { image: number; role: string }[];
      retention: { keepPerRole: number };
    };
    expect(body.ok).toBe(true);
    expect(body.created).toHaveLength(5);
    expect(imageActions).toHaveLength(5);
    expect(body.created.map((c) => c.role)).toEqual(FLEET_ROLES);
    expect(body.created.every((c) => c.commit === 'abc123def' && c.version === '1.210.001')).toBe(true);

    // Retention: app hat 3 Snapshots → der älteste (203) wird gelöscht.
    expect(body.retention.keepPerRole).toBe(2);
    expect(body.deleted).toHaveLength(1);
    expect(body.deleted[0].image).toBe(203);
    expect(deletedImages).toEqual(['203']);

    // create_image-Payload enthält Rollen-Label + description-Präfix + Commit/Version.
    for (const action of imageActions) {
      const labels = action.payload.labels as Record<string, string>;
      expect(labels.app).toBe('audioMONASTRY');
      expect(FLEET_ROLES).toContain(labels.role);
      expect(labels.commit).toBe('abc123def');
      expect(labels.version).toBe('1.210.001');
      expect(action.payload.description).toMatch(/^samplemonk-snapshot-/);
      expect(action.payload.type).toBe('snapshot');
    }
  });

  it('refresh-snapshots ohne laufende Server liefert ok:false', async () => {
    setupFetchMock({ servers: [], images: [] });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/refresh-snapshots', {
        method: 'POST',
        headers: { cookie },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/Keine laufenden/);
  });

  it('Snapshot-Routen verlangen ein signiertes Session-Cookie', async () => {
    setupFetchMock({ images: [] });
    const env = createEnv();

    const refresh = await worker.fetch(
      new Request('https://anunnakitools.de/api/refresh-snapshots', { method: 'POST' }),
      env,
    );
    expect(refresh.status).toBe(401);
    expect(await refresh.json()).toEqual({ error: 'nicht eingeloggt' });

    const list = await worker.fetch(
      new Request('https://anunnakitools.de/api/snapshots'),
      env,
    );
    expect(list.status).toBe(401);
    expect(await list.json()).toEqual({ error: 'nicht eingeloggt' });
  });

  it('GET /api/snapshots listet die Rollen-Snapshots', async () => {
    const images = [
      { id: 301, name: 'samplemonk-snapshot-app-20260902', description: 'samplemonk-snapshot-app-2026-09-02', status: 'available', created: '2026-09-02T10:00:00+00:00', disk_size: 40, labels: { app: 'audioMONASTRY', role: 'app', commit: 'abc123', version: '1.210.001' } },
    ];
    setupFetchMock({ images });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/snapshots', {
        headers: { cookie },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshots: { id: number; role: string; commit: string | null; version: string | null }[] };
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]).toMatchObject({ id: 301, role: 'app', commit: 'abc123', version: '1.210.001' });
  });
});
