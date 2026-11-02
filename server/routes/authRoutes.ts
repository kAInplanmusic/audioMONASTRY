/**
 * audioMONASTRY · Auth Routes (DB-004)
 * ====================================
 * POST /api/auth/login → 4 test accounts (dj, producer, engineer, admin, pw=name)
 * Returns a session token compatible with the existing studio auth system
 * (verifyStudioSession in src/core/session/studioSession.ts).
 */
import type { Express } from 'express';
import { findUser, createSession } from '../userStore';
import { signStudioSession } from '../../src/core/session/studioSession';

const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret-key-change-in-production';

export function registerAuthRoutes(app: Express): void {
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }

    const user = findUser(String(username), String(password));
    if (!user) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const sessionId = createSession(user.id, user.username, user.role);
    const token = await signStudioSession(SESSION_SECRET, {
      sub: user.username,
      ttlS: 900,
    });

    res.json({
      ok: true,
      token,
      session: {
        id: sessionId,
        username: user.username,
        role: user.role,
      },
    });
  });
}