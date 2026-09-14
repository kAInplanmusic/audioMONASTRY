import { describe, it, expect } from 'vitest';
import { parseSessionSnapshot } from '../src/core/session/sessionStateBridge';

describe('sessionStateBridge', () => {
  it('übersetzt einen gültigen Server-Snapshot in Client-Formate', () => {
    const now = Date.now();
    const parsed = parseSessionSnapshot({
      revision: 7,
      serverTime: now,
      modules: {
        eq: { state: 'PRO', revision: 5, updatedBy: 'user-a1b2c3' },
        mixer: { state: 'AUTO_AI', revision: 6, updatedBy: 'user-d4e5f6' },
        stem: { state: 'OFF', revision: 2, updatedBy: 'user-a1b2c3' },
      },
      locks: [{ objectId: 'eq', ownerId: 'user-a1b2c3', leaseUntil: now + 60_000, renewals: 1 }],
      sequences: { 'user-a1b2c3': 4 },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.revision).toBe(7);
    expect(parsed?.modules).toEqual({
      eq: 'PRO',
      mixer: 'AUTO_AI',
      stem: 'OFF',
    });
    expect(parsed?.locks.eq).toMatchObject({
      lockedBy: 'user-a1b2c3',
      active: true,
    });
    expect(parsed?.locks.eq.ttl).toBeGreaterThan(0);
    expect(parsed?.locks.eq.ttl).toBeLessThanOrEqual(60_000);
  });

  it('verwirft strukturell unbrauchbare Payloads', () => {
    expect(parseSessionSnapshot(null)).toBeNull();
    expect(parseSessionSnapshot(undefined)).toBeNull();
    expect(parseSessionSnapshot('nope')).toBeNull();
    expect(parseSessionSnapshot({})).toBeNull();
    expect(parseSessionSnapshot({ revision: -1 })).toBeNull();
    expect(parseSessionSnapshot({ revision: 'x' })).toBeNull();
  });

  it('überspringt ungültige Modul-Einträge defensiv', () => {
    const parsed = parseSessionSnapshot({
      revision: 1,
      serverTime: Date.now(),
      modules: {
        ok: { state: 'PRO', revision: 1, updatedBy: 'user-x' },
        badState: { state: 'LOUD', revision: 1, updatedBy: 'user-x' },
        notObject: 42,
        '': { state: 'AUTO_AI' },
      },
    });
    expect(parsed?.modules).toEqual({ ok: 'PRO' });
  });

  it('ignoriert abgelaufene Locks und Locks ohne Owner', () => {
    const now = Date.now();
    const parsed = parseSessionSnapshot({
      revision: 1,
      serverTime: now,
      locks: [
        { objectId: 'eq', ownerId: 'user-a', leaseUntil: now - 1_000, renewals: 0 },
        { objectId: 'mixer', ownerId: '', leaseUntil: now + 60_000, renewals: 0 },
        { objectId: 'stem', ownerId: 'user-b', leaseUntil: now + 120_000, renewals: 2 },
      ],
    });
    expect(parsed?.locks).not.toHaveProperty('eq');
    expect(parsed?.locks).not.toHaveProperty('mixer');
    expect(parsed?.locks.stem).toMatchObject({ lockedBy: 'user-b', active: true });
  });

  it('liefert leere Module/Locks, wenn der Snapshot sie nicht enthält', () => {
    const parsed = parseSessionSnapshot({ revision: 3, serverTime: Date.now() });
    expect(parsed?.modules).toEqual({});
    expect(parsed?.locks).toEqual({});
  });
});
