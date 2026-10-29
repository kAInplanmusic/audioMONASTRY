import { describe, expect, it } from 'vitest';
import {
  hashIdentity,
  resolveTrustedCostIdentity,
} from '../server/rateLimitKeys';

const normalizeNetwork = (ip: string) => `net:${ip}`;

describe('DB-008: billable rate limits must not trust x-session-id', () => {
  it('ignores 20 chosen client session IDs behind one master-token origin', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      keys.add(resolveTrustedCostIdentity({
        token: 'shared-master-token',
        sessionId: `user-chosen-${i}`,
        ip: '192.0.2.1',
      }, normalizeNetwork));
    }
    expect([...keys]).toEqual(['cost:network:net:192.0.2.1']);
  });

  it('ignores session ID mutations and anonymous portal-token refresh', () => {
    const tokenA = 'v1.1800001000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const tokenB = 'v1.1800002000.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const a = resolveTrustedCostIdentity({ token: tokenA, sessionId: 'alice-1', ip: '198.51.100.2' }, normalizeNetwork);
    const b = resolveTrustedCostIdentity({ token: tokenB, sessionId: 'mallory-2', ip: '198.51.100.2' }, normalizeNetwork);
    expect(a).toBe(b);
  });

  it('uses a signed subject rather than IP for distinct authenticated identities', () => {
    const first = 'v1.1800001000.alice.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const renewed = 'v1.1800002000.alice.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const other = 'v1.1800001000.bob.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const a = resolveTrustedCostIdentity({ token: first, sessionId: 'any', ip: '203.0.113.1' }, normalizeNetwork);
    const b = resolveTrustedCostIdentity({ token: renewed, sessionId: 'changed', ip: '203.0.113.9' }, normalizeNetwork);
    const c = resolveTrustedCostIdentity({ token: other, sessionId: 'any', ip: '203.0.113.1' }, normalizeNetwork);
    expect(a).toBe(`cost:subject:${hashIdentity('alice')}`);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('falls back to normalized network for missing credentials', () => {
    expect(resolveTrustedCostIdentity({ sessionId: 'spoofed', ip: '203.0.113.7' }, normalizeNetwork))
      .toBe('cost:network:net:203.0.113.7');
  });
});
