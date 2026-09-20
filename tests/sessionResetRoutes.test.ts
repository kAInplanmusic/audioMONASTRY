/**
 * F8 · POST /api/session/reset — Schranken und WIRKUNG
 * ===================================================
 * Befund (docs/FIXPLAN_2026-09-20_externer_apptest.md, F8): Der Reset-Hook war
 * ohne expliziten Schalter aktiv und belegte seine Wirkung nicht — es gab keinen
 * Weg, den Zustand danach zu lesen.
 *
 * Dieser Test prüft genau die drei Schranken und die Wirkung:
 *   * **Produktion** (NODE_ENV=production) → 404, selbst mit Schalter UND Token.
 *   * **Schalter aus** (Nicht-Produktion) → 404.
 *   * **Schalter an** → Token Pflicht (401 ohne/falsch), mit Token 200 — und der
 *     Zustand ist danach NACHWEISBAR auf dem Anfangszustand: an einem echten
 *     `AuthoritativeSession`-Objekt mit Revision > 0, gesetzten Modul-States und
 *     gehaltenem Lock (kein Fake, keine Behauptung).
 *
 * Zusätzlich über den echten Serverprozess (server.ts): der Hook ist mit dem
 * Schalter aktiv, `GET /api/session/state` liefert lesbar zurück, und die
 * Session-Instanz-ID wechselt — erst damit ist „wirklich zurückgesetzt“ messbar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthoritativeSession } from '../src/core/session/authoritativeSession';
import { registerSessionRoutes, type SessionRoutesDeps } from '../server/routes/sessionRoutes';

// --- Integrationslauf: Schalter + Token VOR dem Server-Import setzen ----------
process.env.VITEST = 'true';
process.env.NODE_ENV = 'test';
process.env.AUDIOMONASTRY_TEST_RESET = '1';
process.env.STUDIO_ACCESS_TOKEN = 'f8-test-token';

const TOKEN = 'f8-test-token';

interface Harness {
  app: Express;
  session(): AuthoritativeSession;
  stats: { persists: number; saveTimerCleared: number; broadcasts: Array<{ room: string; event: string; payload: unknown }> };
}

/** App mit echten Session-Objekten — die Schranken kommen aus den Deps. */
function buildHarness(options: {
  isProductionEnv: boolean;
  testResetEnabled: boolean;
  studioAccessToken?: string;
}): Harness {
  let session = new AuthoritativeSession({ lockTtlMs: 60_000 });
  const stats: Harness['stats'] = { persists: 0, saveTimerCleared: 0, broadcasts: [] };
  const app = express();
  app.use(express.json());
  const deps: SessionRoutesDeps = {
    isProductionEnv: options.isProductionEnv,
    testResetEnabled: options.testResetEnabled,
    studioAccessToken: options.studioAccessToken ?? '',
    tokenFromRequest: (req: unknown) => String((req as { headers?: Record<string, string> }).headers?.['x-studio-token'] ?? ''),
    safeTokenEqual: (a, b) => a === b,
    newSession: () => new AuthoritativeSession({ lockTtlMs: 60_000 }),
    getSession: () => session,
    replaceSession: (next) => { session = next; },
    persistSession: () => { stats.persists += 1; },
    clearSaveTimer: () => { stats.saveTimerCleared += 1; },
    serverIo: {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => stats.broadcasts.push({ room, event, payload }),
      }),
    },
    uploadToR2: async (key: string) => ({ url: `https://r2.invalid/${key}` }),
  };
  registerSessionRoutes(app, deps);
  return { app, session: () => session, stats };
}

async function listen(app: Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Startzustand "verschmutzen": Revision, Modul-State und Lock setzen. */
function pollute(session: AuthoritativeSession): void {
  const first = session.applyEvent({ id: 'evt-1', type: 'plugin-state', senderUserId: 'u1', pluginId: 'mixer', state: 'PRO' });
  expect(first.accepted).toBe(true);
  const second = session.applyEvent({ id: 'evt-2', type: 'plugin-state', senderUserId: 'u1', pluginId: 'effect', state: 'AUTO_AI' });
  expect(second.accepted).toBe(true);
  expect(session.acquireLock('mixer', 'u1').ok).toBe(true);
}

describe('F8: /api/session/reset — Schranken (echtes HTTP auf der Route)', () => {
  it('Produktion: 404 — auch mit gesetztem Schalter und gültigem Token', async () => {
    const harness = buildHarness({ isProductionEnv: true, testResetEnabled: true, studioAccessToken: TOKEN });
    const { baseUrl, close } = await listen(harness.app);
    try {
      const withToken = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST', headers: { 'x-studio-token': TOKEN } });
      expect(withToken.status).toBe(404);
      const withoutToken = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST' });
      expect(withoutToken.status).toBe(404);
      // Auch der Lese-Zugang bleibt in Produktion abwesend.
      const state = await fetch(`${baseUrl}/api/session/state`, { headers: { 'x-studio-token': TOKEN } });
      expect(state.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('Nicht-Produktion ohne Schalter: 404 (Hook ist abwesend, nicht nur gesperrt)', async () => {
    const harness = buildHarness({ isProductionEnv: false, testResetEnabled: false, studioAccessToken: TOKEN });
    const { baseUrl, close } = await listen(harness.app);
    try {
      const res = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST', headers: { 'x-studio-token': TOKEN } });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('Schalter an: Token ist Pflicht (401 ohne und mit falschem Token)', async () => {
    const harness = buildHarness({ isProductionEnv: false, testResetEnabled: true, studioAccessToken: TOKEN });
    const { baseUrl, close } = await listen(harness.app);
    try {
      const withoutToken = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST' });
      expect(withoutToken.status).toBe(401);
      expect((await withoutToken.json() as { code?: string }).code).toBe('STUDIO_TOKEN_REQUIRED');
      const wrongToken = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST', headers: { 'x-studio-token': 'falsch' } });
      expect(wrongToken.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('Schalter an, aber KEIN Studio-Token konfiguriert → 401 (fail-closed, kein stiller Dev-Reset)', async () => {
    const harness = buildHarness({ isProductionEnv: false, testResetEnabled: true });
    const { baseUrl, close } = await listen(harness.app);
    try {
      const res = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST' });
      expect(res.status).toBe(401);
      // Und der Zustand bleibt unangetastet.
      expect(harness.stats.persists).toBe(0);
      expect(harness.stats.saveTimerCleared).toBe(0);
    } finally {
      await close();
    }
  });

  it('Schalter an + Token: 200 und der Zustand ist WIRKLICH zurückgesetzt (Revision/Module/Locks)', async () => {
    const harness = buildHarness({ isProductionEnv: false, testResetEnabled: true, studioAccessToken: TOKEN });
    const { baseUrl, close } = await listen(harness.app);
    try {
      const before = harness.session();
      pollute(before);
      expect(before.revision).toBeGreaterThan(0);
      expect(before.lockOwner('mixer')).toBe('u1');

      const stateBefore = await fetch(`${baseUrl}/api/session/state`, { headers: { 'x-studio-token': TOKEN } });
      expect(stateBefore.status).toBe(200);
      const stateBeforeBody = (await stateBefore.json()) as { sessionInstanceId: string; revision: number; locks: unknown[] };
      expect(stateBeforeBody.revision).toBe(before.revision);
      expect(stateBeforeBody.locks).toHaveLength(1);

      const res = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST', headers: { 'x-studio-token': TOKEN } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        sessionInstanceId: string;
        previous: { revision: number; moduleStates: number; locks: number };
        revision: number;
        moduleStates: number;
        locks: number;
      };
      // Der Beleg VOR dem Reset (aus dem alten Zustand gelesen) …
      expect(body.previous.revision).toBe(stateBeforeBody.revision);
      expect(body.previous.moduleStates).toBe(2);
      expect(body.previous.locks).toBe(1);
      // … und die Messung DANACH (aus dem neuen Zustand zurückgelesen).
      expect(body.status).toBe('reset');
      expect(body.revision).toBe(0);
      expect(body.moduleStates).toBe(0);
      expect(body.locks).toBe(0);
      expect(body.sessionInstanceId).not.toBe(stateBeforeBody.sessionInstanceId);

      // Der Serverzustand selbst, nicht nur die Antwort:
      const after = harness.session();
      expect(after).not.toBe(before);
      expect(after.revision).toBe(0);
      expect(after.lockOwner('mixer')).toBeNull();
      expect(after.snapshot().modules).toEqual({});
      expect(after.snapshot().locks).toEqual([]);
      // Locks auch über die Legacy-Sicht (was der Client beim Join bekommt).
      expect(Object.keys(after.snapshot().locks)).toHaveLength(0);

      // Der frische Zustand wurde persistiert und der alte Save-Timer gestoppt.
      expect(harness.stats.persists).toBe(1);
      expect(harness.stats.saveTimerCleared).toBe(1);
      expect(harness.stats.broadcasts).toHaveLength(1);
      expect(harness.stats.broadcasts[0].event).toBe('session-reset');
      expect((harness.stats.broadcasts[0].payload as { sessionInstanceId?: string }).sessionInstanceId).toBe(body.sessionInstanceId);

      // Ein zweiter Reset ist idempotent und erzeugt wieder eine neue Instanz.
      const again = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST', headers: { 'x-studio-token': TOKEN } });
      expect(again.status).toBe(200);
      const againBody = (await again.json()) as { sessionInstanceId: string; revision: number };
      expect(againBody.revision).toBe(0);
      expect(againBody.sessionInstanceId).not.toBe(body.sessionInstanceId);
    } finally {
      await close();
    }
  });
});

describe('F8: /api/session/reset über den echten Serverprozess (server.ts)', () => {
  let server: Server;
  let baseUrl = '';

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
  });

  it('Schalter an + Token: 200, Instanz-ID wechselt, Revision steht auf 0', async () => {
    const beforeRes = await fetch(`${baseUrl}/api/session/state`, { headers: { 'x-studio-token': TOKEN } });
    expect(beforeRes.status).toBe(200);
    const before = (await beforeRes.json()) as { sessionInstanceId: string; revision: number };

    const reset = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST', headers: { 'x-studio-token': TOKEN } });
    expect(reset.status).toBe(200);
    const body = (await reset.json()) as { sessionInstanceId: string; revision: number; moduleStates: number; locks: number };
    expect(body.revision).toBe(0);
    expect(body.moduleStates).toBe(0);
    expect(body.locks).toBe(0);
    expect(body.sessionInstanceId).not.toBe(before.sessionInstanceId);

    // Zurückgelesen über die Route: derselbe neue Zustand ist sichtbar.
    const afterRes = await fetch(`${baseUrl}/api/session/state`, { headers: { 'x-studio-token': TOKEN } });
    expect(afterRes.status).toBe(200);
    const after = (await afterRes.json()) as { sessionInstanceId: string; revision: number; locks: unknown[]; modules: Record<string, unknown> };
    expect(after.sessionInstanceId).toBe(body.sessionInstanceId);
    expect(after.revision).toBe(0);
    expect(after.locks).toEqual([]);
    expect(after.modules).toEqual({});
  });

  it('ohne Token bleibt der Reset wirkungslos (401) — der Zustand wird nicht angetastet', async () => {
    const before = (await (await fetch(`${baseUrl}/api/session/state`, { headers: { 'x-studio-token': TOKEN } })).json()) as { sessionInstanceId: string };
    const res = await fetch(`${baseUrl}/api/session/reset`, { method: 'POST' });
    expect(res.status).toBe(401);
    const after = (await (await fetch(`${baseUrl}/api/session/state`, { headers: { 'x-studio-token': TOKEN } })).json()) as { sessionInstanceId: string };
    expect(after.sessionInstanceId).toBe(before.sessionInstanceId);
  });
});
