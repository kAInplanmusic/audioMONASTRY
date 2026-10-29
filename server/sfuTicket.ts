/**
 * DAW-Breaker SFU ticket authentication.
 *
 * The SFU may be hosted on a different origin from the studio, so its
 * Socket.IO handshake cannot depend on the app's host-only HttpOnly cookie.
 * A studio-authenticated REST route issues a short-lived HMAC ticket for one
 * SFU session; the SFU checks both signature and session binding.
 *
 * This deliberately does NOT accept master tokens as SFU tickets.
 */
import { signStudioSession, verifyStudioSession } from '../src/core/session/studioSession';

export const SFU_TICKET_TTL_S = 90;
const SFU_SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validSfuSessionId(input: unknown): input is string {
  return typeof input === 'string' && SFU_SESSION_RE.test(input);
}

function ticketSubject(sessionId: string): string {
  return `sfu_${sessionId}`;
}

/** Only call from an API handler already guarded by studio authentication. */
export async function issueSfuTicket(
  secret: string,
  sessionId: string,
  opts: { nowSec?: number } = {},
): Promise<{ ticket: string; expiresAt: number; expiresIn: number }> {
  if (!secret.trim()) throw new Error('SFU session secret not configured');
  if (!validSfuSessionId(sessionId)) throw new Error('Invalid SFU session ID');
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const ticket = await signStudioSession(secret, {
    nowSec, ttlS: SFU_TICKET_TTL_S, sub: ticketSubject(sessionId),
  });
  return { ticket, expiresAt: nowSec + SFU_TICKET_TTL_S, expiresIn: SFU_TICKET_TTL_S };
}

export async function verifySfuTicket(
  token: unknown,
  secret: string,
  sessionId: unknown,
  opts: { nowSec?: number } = {},
): Promise<boolean> {
  if (!validSfuSessionId(sessionId) || !secret.trim()) return false;
  if (typeof token !== 'string' || token.length > 256) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || parts[2] !== ticketSubject(sessionId)) return false;
  return verifyStudioSession(token, secret, opts);
}
