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
    // Ohne diesen Token bricht `syncOriginDns` sofort mit
    // "CLOUDFLARE_API_TOKEN fehlt im Worker" ab - im Live-Fall war der Token
    // abgelaufen und die Verdrahtung scheiterte still. Beides deckt der Test ab.
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
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `portal=${encodeURIComponent(`${payload}.${hex}`)}`;
}

interface FetchMockOptions {
  /** true = die Cloudflare-Zonenabfrage liefert nichts (abgelaufener Token, LIVE-Fall). */
  cloudflareZoneMissing?: boolean;
  images?: unknown[];
  servers?: unknown[];
  createServer?: (payload: Record<string, unknown>) => Record<string, unknown>;
  createImage?: (serverId: string, payload: Record<string, unknown>) => Record<string, unknown>;
  /**
   * INFRA-HETZNER-008: Status, den `GET /v1/actions/:id` meldet. 'success' (Default)
   * lässt den Stop-Pfad löschen, 'error'/'running' muss ihn stoppen.
   */
  actionStatus?: string;
  /** Floating-IPs, die der Stop-Pfad löschen darf (Default: eine). */
  floatingIps?: { id: number; name?: string; ip?: string }[];
}

function setupFetchMock(opts: FetchMockOptions = {}) {
  const serverPayloads: Record<string, unknown>[] = [];
  const dnsPatches: { content?: string }[] = [];
  let serverGetCount = 0;
  const imageActions: { serverId: string; payload: Record<string, unknown> }[] = [];
  const deletedImages: string[] = [];
  const deletedServers: string[] = [];
  const deletedFloatingIps: string[] = [];
  const order: string[] = [];

  const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';

    if (url.hostname === 'api.cloudflare.com') {
      // Cloudflare-API gezielt beantworten: die IP-Ranges braucht die Firewall,
      // Zonen + DNS-Records die Verdrahtung der origin-Domain.
      if (url.pathname === '/client/v4/ips') {
        return Response.json({ result: { ipv4_cidrs: ['1.2.3.0/24'], ipv6_cidrs: [] } });
      }
      if (url.pathname === '/client/v4/zones') {
        return Response.json({ result: opts.cloudflareZoneMissing ? [] : [{ id: 'zone-1', name: 'anunnakitools.de' }] });
      }
      if (/^\/client\/v4\/zones\/[^/]+\/dns_records/.test(url.pathname)) {
        if (method === 'PATCH') {
          dnsPatches.push(JSON.parse(String(init.body ?? '{}')) as { content?: string });
          return Response.json({ success: true, result: { id: 'rec-1' } });
        }
        return Response.json({ result: [{ id: 'rec-1', type: 'A', name: 'origin.anunnakitools.de', content: '9.9.9.9' }] });
      }
      return Response.json({ result: {} });
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
    const deleteServerMatch = /^\/v1\/servers\/(\d+)$/.exec(path);
    if (deleteServerMatch && method === 'DELETE') {
      deletedServers.push(deleteServerMatch[1]);
      order.push(`delete-server:${deleteServerMatch[1]}`);
      return new Response(null, { status: 204 });
    }
    if (path === '/v1/images' && method === 'GET') {
      return Response.json({ images: opts.images ?? [] });
    }
    const createImageMatch = /^\/v1\/servers\/(\d+)\/actions\/create_image$/.exec(path);
    if (createImageMatch && method === 'POST') {
      const payload = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      imageActions.push({ serverId: createImageMatch[1], payload });
      order.push(`create_image:${createImageMatch[1]}`);
      const created = opts.createImage?.(createImageMatch[1], payload) ?? {
        action: { id: 1000 + imageActions.length },
      };
      return Response.json(created);
    }
    const actionMatch = /^\/v1\/actions\/(\d+)$/.exec(path);
    if (actionMatch && method === 'GET') {
      return Response.json({ action: { id: Number(actionMatch[1]), status: opts.actionStatus ?? 'success' } });
    }
    if (path === '/v1/floating_ips' && method === 'GET') {
      return Response.json({ floating_ips: opts.floatingIps ?? [{ id: 7, name: 'audiomonastry-floating', ip: '9.9.9.9' }] });
    }
    const deleteFipMatch = /^\/v1\/floating_ips\/(\d+)$/.exec(path);
    if (deleteFipMatch && method === 'DELETE') {
      deletedFloatingIps.push(deleteFipMatch[1]);
      order.push(`delete-fip:${deleteFipMatch[1]}`);
      return new Response(null, { status: 204 });
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
  return { fetchMock, serverPayloads, imageActions, deletedImages, deletedServers, deletedFloatingIps, dnsPatches, order };
}

describe('Portal-Worker OPS-Snapshot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // LIVE-BEFUND 2026-09-18: die Portal-Snapshots haben KEIN Label und KEINEN
  // Namen, nur die Beschreibung. Mit der reinen Label-Abfrage lief jeder Wake als
  // Kaltstart (gemessen: `usedSnapshots: {}`, cloud-init + Build auf allen
  // Knoten). Dieser Test haelt fest, dass die Rolle aus der Beschreibung faellt.
  it('findet Snapshots, die nur eine Beschreibung tragen (Live-Fall)', async () => {
    const images = FLEET_ROLES.map((role, i) => ({
      id: 201 + i,
      name: null,
      description: `samplemonk-snapshot-${role}-2026-09-18`,
      status: 'available',
      created: '2026-09-18T10:00:00+00:00',
      labels: {},
    }));
    const { serverPayloads } = setupFetchMock({ images });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/wake', { method: 'POST', headers: { cookie } }),
      env,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.fallbackRoles ?? []).toEqual([]); // kein cloud-init-Fallback
    expect(Object.keys(body.usedSnapshots ?? {}).sort()).toEqual([...FLEET_ROLES].sort());
    // Jede erzeugte Server-Anfrage traegt ein Snapshot-Image (2xx) statt der Basis.
    const appPayload = serverPayloads.find((p) => p.name === 'audiomonastry-app-1');
    expect(appPayload?.image).toBe(201 + FLEET_ROLES.indexOf('app'));
  });

  // LIVE-BEFUND 2026-09-18: `startFleet` verdrahtet die Flotte (Firewall, origin-DNS,
  // Ports), verschluckte das Ergebnis aber (`console.warn`). Starb die DNS-Setzung
  // (abgelaufener Cloudflare-Token), blieb das Portal dauerhaft in 'starting-app' mit
  // HTTP 522 - ohne Hinweis fuer den Betreiber. Diese Tests halten fest, dass das
  // Ergebnis zurueckkommt UND dass ein Fehlschlag sichtbar ist.
  it('meldet die Flotten-Verdrahtung zurueck und setzt die origin-DNS', async () => {
    const images = FLEET_ROLES.map((role, i) => ({
      id: 301 + i,
      name: null,
      description: `samplemonk-snapshot-${role}-2026-09-18`,
      status: 'available',
      created: '2026-09-18T10:00:00+00:00',
      labels: {},
    }));
    const { dnsPatches } = setupFetchMock({ images });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/wake', { method: 'POST', headers: { cookie } }),
      env,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.wiring?.dns?.ok).toBe(true);
    expect(dnsPatches.length, 'kein DNS-PATCH abgesetzt').toBeGreaterThan(0);
    expect(dnsPatches[0].content).toBe('1.2.3.4'); // app-1-IP aus dem Mock
  });

  it('macht einen DNS-Fehlschlag sichtbar statt ihn zu verschlucken', async () => {
    const images = FLEET_ROLES.map((role, i) => ({
      id: 401 + i,
      name: null,
      description: `samplemonk-snapshot-${role}-2026-09-18`,
      status: 'available',
      created: '2026-09-18T10:00:00+00:00',
      labels: {},
    }));
    setupFetchMock({ images, cloudflareZoneMissing: true });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/wake', { method: 'POST', headers: { cookie } }),
      env,
    );
    const body = await res.json();

    expect(res.status).toBe(200); // der Start selbst klappt ...
    expect(body.wiring?.dns?.ok).toBe(false); // ... die Verdrahtung nicht
    expect(String(body.wiring?.dns?.message ?? '')).toContain('Cloudflare-Zone');
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
      expect(action.payload.description).toMatch(/^audiomonastry-snapshot-/);
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

/**
 * NOMEN-P1-001: Die Umbenennung darf laufende Installationen nicht brechen.
 * Der Portal-Worker akzeptiert daher BEIDE Schreibweisen: Bestandsressourcen mit
 * Altnamen bleiben bedienbar, Alt-Snapshots bleiben auffindbar und werden weiter
 * aufgeraeumt - neu angelegt wird immer mit dem neuen Namen.
 */
describe('NOMEN-P1-001 · Altnamen-Kompatibilitaet (Bestandsflotte)', () => {
  it('erkennt eine Flotte, die noch die alten Servernamen traegt', async () => {
    // Fixture bewusst mit ALTen Namen: genau das ist eine laufende Installation.
    setupFetchMock({ servers: FLEET_SERVERS, images: [] });

    const env = createEnv();
    // /api/fleet-map ist der Weg, den die App beim Start nutzt (Studio-Token).
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/fleet-map', {
        headers: { 'x-studio-token': String(env.STUDIO_ACCESS_TOKEN) },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { fleet?: Record<string, string> };
    // Die Altflotte wird unter dem NEUEN Schluessel geliefert - genau so findet
    // die umbenannte App ihre Knoten, ohne dass Server umbenannt werden muessen.
    expect(body.fleet?.['audiomonastry-app-1']).toBe('1.2.3.4');
    // Alle fuenf Rollen erscheinen unter dem NEUEN Namen, obwohl die Fixture
    // durchgehend Alt-Namen traegt (master/ai/... ohne oeffentliche IP im Fixture).
    expect(Object.keys(body.fleet ?? {}).sort()).toEqual(
      ['audiomonastry-ai-1', 'audiomonastry-app-1', 'audiomonastry-edge-1', 'audiomonastry-master-1', 'audiomonastry-sfu-1'],
    );
    expect(Object.keys(body.fleet ?? {}).some((k) => k.startsWith('samplemonk-'))).toBe(false);
  });

  it('findet Snapshots mit Altpraefix weiter (schneller Start + Retention)', async () => {
    const legacyImage = {
      id: 91, name: 'samplemonk-snapshot-app-20260801',
      description: 'samplemonk-snapshot-app-2026-08-01', status: 'available',
      created: '2026-08-01T10:00:00+00:00', labels: { app: 'audioMONASTRY', role: 'app' },
    };
    setupFetchMock({ images: [legacyImage] });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/snapshots', { headers: { cookie } }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshots?: { id: number }[] };
    // Auch Alt-Snapshots werden gelistet - sonst blieben sie unbemerkt liegen
    // (Speicherkosten) und der schnelle Flotten-Start waere unnoetig langsam.
    expect((body.snapshots ?? []).map((s) => s.id)).toContain(91);
  });
});

/**
 * INFRA-HETZNER-008: Der Portal-Stop-Pfad loeschte die Flotte ohne jede
 * Sicherung - ein Stop (oder der Auto-Stop-Cron nach Idle) war unwiederbringlich,
 * waehrend der CLI-Pfad schon immer einen Snapshot zog. Diese Tests halten die
 * neue Regel fest: erst Snapshot, dann loeschen, und nur loeschen, wenn der
 * Snapshot bestaetigt ist. Loeschen ohne bestaetigten Snapshot = Datenverlust.
 */
describe('INFRA-HETZNER-008 · Stop zieht erst Snapshots, dann loeschen', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('legt je Knoten einen Snapshot an, wartet auf success und loescht DANN', async () => {
    const { imageActions, deletedServers, deletedFloatingIps, order } = setupFetchMock({ servers: FLEET_SERVERS });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/stop', { method: 'POST', headers: { cookie } }),
      env,
    );
    const body = (await res.json()) as {
      deleted?: string[];
      skipped?: unknown[];
      snapshots?: { entry: { ok: boolean } }[];
      fipDeleted?: string[];
    };

    expect(res.status).toBe(200);
    expect(imageActions).toHaveLength(FLEET_SERVERS.length);
    expect(deletedServers).toHaveLength(FLEET_SERVERS.length);
    expect(body.skipped ?? []).toEqual([]);
    expect(deletedFloatingIps).toEqual(['7']);

    // Reihenfolge: ALLE create_image-Aufrufe vor dem ERSTEN Server-Delete.
    const firstDelete = order.findIndex((entry) => entry.startsWith('delete-server'));
    const lastCreate = order.map((entry) => entry.startsWith('create_image')).lastIndexOf(true);
    expect(firstDelete).toBeGreaterThan(-1);
    expect(lastCreate).toBeLessThan(firstDelete);
  });

  it('loescht KEINEN Knoten, wenn der Snapshot fehlschlaegt', async () => {
    const { imageActions, deletedServers, deletedFloatingIps } = setupFetchMock({
      servers: FLEET_SERVERS,
      actionStatus: 'error',
    });

    const env = createEnv();
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/stop', { method: 'POST', headers: { cookie } }),
      env,
    );
    const body = (await res.json()) as { deleted?: string[]; skipped?: { reason?: string }[] };

    expect(res.status).toBe(200);
    // Snapshots wurden versucht, aber nichts geloescht - und das ist sichtbar.
    expect(imageActions).toHaveLength(FLEET_SERVERS.length);
    expect(deletedServers).toEqual([]);
    expect(body.deleted ?? []).toEqual([]);
    expect(body.skipped?.length).toBe(FLEET_SERVERS.length);
    expect(String(body.skipped?.[0]?.reason ?? '')).toContain('Snapshot-Status error');
    // Ohne geloeschte Server darf auch die Floating-IP nicht weg (DNS-Schutz).
    expect(deletedFloatingIps).toEqual([]);
  });

  it('loescht bei Snapshot-Timeout ebenfalls nicht', async () => {
    const { deletedServers, deletedFloatingIps } = setupFetchMock({
      servers: FLEET_SERVERS,
      actionStatus: 'running',
    });

    const env = createEnv();
    // Budget 0 s: der Poll bricht sofort ab (kein Warten im Test) - geloescht wird nicht.
    env.STOP_SNAPSHOT_TIMEOUT_S = '0';
    const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
    const res = await worker.fetch(
      new Request('https://anunnakitools.de/api/stop', { method: 'POST', headers: { cookie } }),
      env,
    );
    const body = (await res.json()) as { skipped?: { reason?: string }[] };

    expect(res.status).toBe(200);
    expect(deletedServers).toEqual([]);
    expect(deletedFloatingIps).toEqual([]);
    expect(String(body.skipped?.[0]?.reason ?? '')).toContain('Snapshot-Status timeout');
  });
});
