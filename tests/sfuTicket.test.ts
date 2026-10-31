import { describe, expect, it } from 'vitest';
import {
  issueSfuTicket,
  verifySfuTicket,
  validSfuSessionId,
  SFU_TICKET_TTL_S,
} from '../server/sfuTicket';
import { signStudioSession } from '../src/core/session/studioSession';

const secret = 'test-sfu-secret-not-production';
const nowSec = 1_800_000_000;

describe('DB-005: SFU admission tickets', () => {
  it('issues a short-lived token for exactly one named session', async () => {
    const { ticket, expiresAt, expiresIn } = await issueSfuTicket(secret, 'studio-session', { nowSec });
    expect(expiresIn).toBe(90);
    expect(expiresAt).toBe(nowSec + SFU_TICKET_TTL_S);
    expect(await verifySfuTicket(ticket, secret, 'studio-session', { nowSec })).toBe(true);
    expect(await verifySfuTicket(ticket, secret, 'other-session', { nowSec })).toBe(false);
    expect(await verifySfuTicket(ticket, secret, 'studio-session', { nowSec: expiresAt })).toBe(false);
  });

  it('rejects absent, corrupted and mismatched tokens', async () => {
    const { ticket } = await issueSfuTicket(secret, 'main', { nowSec });
    expect(await verifySfuTicket(null, secret, 'main', { nowSec })).toBe(false);
    expect(await verifySfuTicket('', secret, 'main', { nowSec })).toBe(false);
    expect(await verifySfuTicket(ticket + 'x', secret, 'main', { nowSec })).toBe(false);
    expect(await verifySfuTicket(ticket, 'another-secret', 'main', { nowSec })).toBe(false);
    expect(await verifySfuTicket(ticket, '', 'main', { nowSec })).toBe(false);
    expect(await verifySfuTicket(ticket, secret, '', { nowSec })).toBe(false);
  });

  it('does not accept ordinary studio sessions as SFU grants', async () => {
    const ordinary = await signStudioSession(secret, { nowSec, ttlS: 90 });
    const portalSubject = await signStudioSession(secret, { nowSec, ttlS: 90, sub: 'alice' });
    expect(await verifySfuTicket(ordinary, secret, 'main', { nowSec })).toBe(false);
    expect(await verifySfuTicket(portalSubject, secret, 'main', { nowSec })).toBe(false);
  });

  it('rejects invalid IDs and refuses to issue tickets without shared secret', async () => {
    for (const id of ['../main', 'session.with.dots', '', 'a'.repeat(65), 'x y']) {
      expect(validSfuSessionId(id)).toBe(false);
      await expect(issueSfuTicket(secret, id, { nowSec })).rejects.toThrow();
    }
    expect(validSfuSessionId('studio-session')).toBe(true);
    await expect(issueSfuTicket('', 'main', { nowSec })).rejects.toThrow();
  });

  it('rejects a signed ticket with another session binding even with the correct HMAC', async () => {
    const token = await signStudioSession(secret, { nowSec, ttlS: 90, sub: 'sfu_other' });
    expect(await verifySfuTicket(token, secret, 'main', { nowSec })).toBe(false);
  });
});
