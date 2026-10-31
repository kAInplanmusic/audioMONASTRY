import { afterAll, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerOpsRoutes, type OpsDeps } from '../server/routes/opsRoutes';

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))));
});

const entry = { ts: '2026-01-01T00:00:00Z', userId: 'private-user', role: 'guest', action: 'denied', ok: false };
async function registerAndGet(guard?: OpsDeps['isOperatorRequest']) {
  const app = express();
  const deps = {
    STEM_MAX_JOBS: 1,
    getActiveSocketConnections: () => 0,
    getStemActiveJobs: () => 0,
    metrics: {} as OpsDeps['metrics'],
    serverAuditLog: [entry],
    ...(guard ? { isOperatorRequest: guard } : {}),
  };
  registerOpsRoutes(app, deps);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/audit`);
}

it('does not expose audit entries when the operator callback is missing', async () => {
  const res = await registerAndGet();
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'forbidden', code: 'AUDIT_OPERATOR_ONLY' });
});

it('denies access when the supplied callback rejects the request', async () => {
  const res = await registerAndGet(() => false);
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'forbidden', code: 'AUDIT_OPERATOR_ONLY' });
});

it('returns the actual audit entry when the supplied callback allows access', async () => {
  const res = await registerAndGet(() => true);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ entries: [entry], total: 1 });
});
