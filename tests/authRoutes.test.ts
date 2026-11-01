/**
 * DB-004 · Auth Routes Test (User Login with 4 Test Accounts)
 *
 * Tests for POST /api/auth/login endpoint.
 * 4 test accounts: dj, producer, engineer, admin (pw = username)
 */
process.env.NODE_ENV ??= 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { registerAuthRoutes } from '../server/routes/authRoutes';

let server: Server;
let baseUrl = '';

const post = (p: string, body: unknown) =>
  fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(() => {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('DB-004 /api/auth/login', () => {
  const testAccounts = [
    { username: 'dj', role: 'dj' as const },
    { username: 'producer', role: 'producer' as const },
    { username: 'engineer', role: 'engineer' as const },
    { username: 'admin', role: 'admin' as const },
  ];

  it('rejects missing username or password', async () => {
    expect((await post('/api/auth/login', {})).status).toBe(400);
    expect((await post('/api/auth/login', { username: 'test' })).status).toBe(400);
    expect((await post('/api/auth/login', { password: 'test' })).status).toBe(400);
  });

  it('rejects invalid credentials', async () => {
    expect((await post('/api/auth/login', { username: 'unknown', password: 'wrong' })).status).toBe(401);
    expect((await post('/api/auth/login', { username: 'dj', password: 'wrong' })).status).toBe(401);
    expect((await post('/api/auth/login', { username: 'unknown', password: 'unknown' })).status).toBe(401);
  });

  it.each(testAccounts)('accepts valid login for %s account', async (account) => {
    const res = await post('/api/auth/login', {
      username: account.username,
      password: account.username, // pw = username for test accounts
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      token: string;
      session: { id: string; username: string; role: string };
    };
    expect(body.ok).toBe(true);
    expect(body.token).toMatch(/^v1\.\d+\.\w+\.[a-zA-Z0-9_-]+$/);
    expect(body.session.username).toBe(account.username);
    expect(body.session.role).toBe(account.role);
    expect(body.session.id).toBeTruthy();
  });

  it('returns token format compatible with studioSession', async () => {
    const res = await post('/api/auth/login', {
      username: 'admin',
      password: 'admin',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const parts = body.token.split('.');
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe('v1');
    // parts[1] = expiry, parts[2] = subject (username), parts[3] = signature
    expect(parts[2]).toBe('admin');
  });
});