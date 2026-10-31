import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import express from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { signStudioSession } from '../src/core/session/studioSession';

const master = 'audit-master-token-for-local-test';
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.STUDIO_ACCESS_TOKEN = master;
  process.env.SESSION_SECRET = 'audit-local-session-secret';
  process.env.TRUST_PROXY = '1';
  process.env.API_RATE_LIMIT_MAX = '2';
  process.env.API_RATE_LIMIT_WINDOW_MS = '60000';
  const { app } = await import('../server');
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Kein lokaler Port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

async function probe(forwarded: string, session: string, token = master): Promise<number> {
  const response = await fetch(`${baseUrl}/api/online`, {
    headers: { 'x-studio-token': token, 'x-session-id': session, 'x-forwarded-for': forwarded },
  });
  await response.arrayBuffer();
  return response.status;
}

describe('AUDIT-2026-10-30-P1-003: Session-Kennung', () => {
  it('ein authentifizierter Client kann durch Kennungswechsel kein neues Budget erzeugen', async () => {
    expect(await probe('198.51.100.10', 'client-aaaa')).toBe(200);
    expect(await probe('198.51.100.10', 'client-aaaa')).toBe(200);
    expect(await probe('198.51.100.10', 'client-aaaa')).toBe(429);
    expect(await probe('198.51.100.10', 'client-bbbb')).toBe(429);
  });

  it('unterschiedliche IPv4-Clients mit demselben Master-Token behalten getrennte Budgets', async () => {
    expect(await probe('198.51.100.20', 'shared-browser-id')).toBe(200);
    expect(await probe('198.51.100.20', 'shared-browser-id')).toBe(200);
    expect(await probe('198.51.100.20', 'shared-browser-id')).toBe(429);
    expect(await probe('198.51.100.21', 'shared-browser-id')).toBe(200);
  });

  it('Clients am gemeinsamen NAT sollen trotz Master-Token getrennte Budgets behalten', async () => {
    expect(await probe('198.51.100.30', 'nat-client-a')).toBe(200);
    expect(await probe('198.51.100.30', 'nat-client-a')).toBe(200);
    expect(await probe('198.51.100.30', 'nat-client-a')).toBe(429);
    expect(await probe('198.51.100.30', 'nat-client-b')).toBe(200);
  });

  it('Session-Token ohne sub können für gleichzeitig ausgelieferte Clients identisch sein', async () => {
    const opts = { nowSec: 1900000000, ttlS: 900 };
    const a = await signStudioSession('audit-local-session-secret', opts);
    const b = await signStudioSession('audit-local-session-secret', opts);
    expect(a).toBe(b);
  });

  it('signierte Subjects teilen beim Tokenwechsel ein Budget, verschiedene Subjects nicht', async () => {
    const a = await signStudioSession('audit-local-session-secret', { sub: 'audit-a', ttlS: 900 });
    const renewed = await signStudioSession('audit-local-session-secret', { sub: 'audit-a', ttlS: 1000 });
    const b = await signStudioSession('audit-local-session-secret', { sub: 'audit-b', ttlS: 900 });
    expect(await probe('198.51.100.40', 'same-device', a)).toBe(200);
    expect(await probe('198.51.100.40', 'same-device', a)).toBe(200);
    expect(await probe('198.51.100.40', 'same-device', renewed)).toBe(429);
    expect(await probe('198.51.100.40', 'same-device', b)).toBe(200);
  });

  it('ohne vertrauenswürdigen Proxy wird ein gefälschtes X-Forwarded-For ignoriert', async () => {
    const localApp = express();
    localApp.use(rateLimit({ windowMs: 60_000, limit: 1, keyGenerator: (req) => ipKeyGenerator(req.ip || '') }));
    localApp.get('/', (_req, res) => res.sendStatus(200));
    const local = localApp.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => local.once('listening', resolve));
    try {
      const addr = local.address();
      if (!addr || typeof addr === 'string') throw new Error('Kein lokaler Port');
      const url = `http://127.0.0.1:${addr.port}/`;
      expect((await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.80' } })).status).toBe(200);
      expect((await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.81' } })).status).toBe(429);
    } finally {
      await new Promise<void>((resolve, reject) => local.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('bei Vertrauen auf einen Proxy kann ein direkter Client X-Forwarded-For fälschen', async () => {
    const localApp = express();
    localApp.set('trust proxy', 1);
    localApp.use(rateLimit({ windowMs: 60_000, limit: 1, keyGenerator: (req) => ipKeyGenerator(req.ip || '') }));
    localApp.get('/', (_req, res) => res.sendStatus(200));
    const local = localApp.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => local.once('listening', resolve));
    try {
      const addr = local.address();
      if (!addr || typeof addr === 'string') throw new Error('Kein lokaler Port');
      const url = `http://127.0.0.1:${addr.port}/`;
      expect((await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.50' } })).status).toBe(200);
      expect((await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.50' } })).status).toBe(429);
      expect((await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.51' } })).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => local.close((err) => err ? reject(err) : resolve()));
    }
  });

  it('ein signiertes Subject bleibt bei wechselndem x-session-id im selben Budget', async () => {
    const token = await signStudioSession('audit-local-session-secret', { sub: 'audit-spoofed-session', ttlS: 900 });
    expect(await probe('198.51.100.70', 'signed-client-a', token)).toBe(200);
    expect(await probe('198.51.100.70', 'signed-client-a', token)).toBe(200);
    expect(await probe('198.51.100.70', 'signed-client-a', token)).toBe(429);
    expect(await probe('198.51.100.70', 'signed-client-b', token)).toBe(429);
  });

  it('eine IPv6-/56-Quelle kann mit Session-Wechsel kein neues Budget erzeugen', async () => {
    expect(await probe('2001:db8:abcd:1200::1', 'ipv6-client-a')).toBe(200);
    expect(await probe('2001:db8:abcd:12ff::2', 'ipv6-client-a')).toBe(200);
    expect(await probe('2001:db8:abcd:1200::3', 'ipv6-client-a')).toBe(429);
    expect(await probe('2001:db8:abcd:12ff::4', 'ipv6-client-b')).toBe(429);
  });

  it('IPv6 wird für IP-Budgets auf /56 normalisiert', () => {
    expect(ipKeyGenerator('2001:db8:abcd:1200::1')).toBe(ipKeyGenerator('2001:db8:abcd:12ff::2'));
    expect(ipKeyGenerator('2001:db8:abcd:1200::1')).not.toBe(ipKeyGenerator('2001:db8:abcd:1300::1'));
    expect(ipKeyGenerator('198.51.100.1')).not.toBe(ipKeyGenerator('198.51.100.2'));
  });
});
