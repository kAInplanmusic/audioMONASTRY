/**
 * audioMONASTRY · Simple User Management (DB-004)
 * ================================================
 * 4 test accounts for E2E testing.
 * Roles: dj, producer, engineer, admin
 * Password: same as username (in production, would be hashed).
 */
import { randomBytes } from 'node:crypto';

export type UserRole = 'dj' | 'producer' | 'engineer' | 'admin';
export type SessionId = string & { readonly __brand: unique symbol };

export interface User {
  id: string;
  username: string;
  role: UserRole;
  password: string; // Plain for test (in production: bcrypt hash)
}

export interface Session {
  id: SessionId;
  userId: string;
  username: string;
  role: UserRole;
  createdAt: number;
  expiresAt: number;
}

// 4 test accounts
export const TEST_USERS: User[] = [
  { id: 'user-1', username: 'dj', role: 'dj', password: 'dj' },
  { id: 'user-2', username: 'producer', role: 'producer', password: 'producer' },
  { id: 'user-3', username: 'engineer', role: 'engineer', password: 'engineer' },
  { id: 'user-4', username: 'admin', role: 'admin', password: 'admin' },
];

const TEST_SESSIONS: Map<string, Session> = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function findUser(username: string, password: string): User | undefined {
  return TEST_USERS.find((u) => u.username === username && u.password === password);
}

export function createSession(userId: string, username: string, role: UserRole): SessionId {
  const id = `sess_${randomBytes(12).toString('hex')}` as SessionId;
  const now = Date.now();
  const session: Session = {
    id,
    userId,
    username,
    role,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  TEST_SESSIONS.set(id, session);
  return id;
}

export function getSession(id: string): Session | undefined {
  const session = TEST_SESSIONS.get(id);
  if (!session) return undefined;
  if (Date.now() > session.expiresAt) {
    TEST_SESSIONS.delete(id);
    return undefined;
  }
  return session;
}

export function validateSession(id: string): Session | null {
  const session = getSession(id);
  return session ?? null;
}

export function hasRole(sessionId: string, requiredRole: UserRole): boolean {
  const session = getSession(sessionId);
  if (!session) return false;
  const roleOrder: UserRole[] = ['dj', 'producer', 'engineer', 'admin'];
  const sessionRank = roleOrder.indexOf(session.role);
  const requiredRank = roleOrder.indexOf(requiredRole);
  return sessionRank >= requiredRank;
}

export function deleteAllSessions(): void {
  TEST_SESSIONS.clear();
}
