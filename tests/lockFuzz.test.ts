// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LockManager } from '../src/core/session/locking';

/** Deterministischer PRNG (Mulberry32) für reproduzierbares Fuzzing. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('AM-E5-3: LockManager Race-Condition-Fuzzing (4 User × 1000 Ops)', () => {
  it('hält die Invariante: nie zwei aktive Besitzer für dasselbe Objekt', () => {
    const rand = mulberry32(0x5eed);
    const users = ['u1', 'u2', 'u3', 'u4'];
    const objects = ['mixer', 'drum', 'synth', 'master'];
    const lm = new LockManager();
    let now = 1_000_000;

    // Referenzmodell: objectId -> { owner, leaseUntil }
    const model = new Map<string, { owner: string; leaseUntil: number }>();

    for (let i = 0; i < 1000; i++) {
      const obj = objects[Math.floor(rand() * objects.length)];
      const user = users[Math.floor(rand() * users.length)];
      const leaseMs = 5 + Math.floor(rand() * 50);
      now += Math.floor(rand() * 30);
      const op = Math.floor(rand() * 3); // 0 acquire, 1 renew, 2 release

      // Vorab abgelaufene Leases aus dem Modell entfernen (LockManager tut
      // dasselbe implizit bei acquire/isLocked/renew).
      let hadExpired = false;
      let expiredOwner = '';
      {
        const cur = model.get(obj);
        if (cur && cur.leaseUntil <= now) {
          hadExpired = true;
          expiredOwner = cur.owner;
          model.delete(obj);
        }
      }

      if (op === 0) {
        const ok = lm.acquire(obj, user, leaseMs, now);
        const cur = model.get(obj);
        if (cur && cur.owner !== user && !hadExpired) {
          expect(ok).toBe(false);
        } else {
          expect(ok).toBe(true);
          model.set(obj, { owner: user, leaseUntil: now + leaseMs });
        }
      } else if (op === 1) {
        const ok = lm.renew(obj, user, leaseMs, now);
        const cur = model.get(obj);
        if (hadExpired && expiredOwner === user) {
          // Abgelaufene Lease desselben Owners wird von renew neu vergeben.
          expect(ok).toBe(true);
          model.set(obj, { owner: user, leaseUntil: now + leaseMs });
        } else if (hadExpired) {
          // Fremder Owner muss acquire nutzen – renew greift nicht.
          expect(ok).toBe(false);
        } else if (!cur || cur.owner !== user) {
          expect(ok).toBe(false);
        } else {
          expect(ok).toBe(true);
          cur.leaseUntil = now + leaseMs;
        }
      } else {
        const ok = lm.release(obj, user, now);
        const cur = model.get(obj);
        if (!cur) expect(ok).toBe(true);
        else if (cur.owner !== user) expect(ok).toBe(false);
        else {
          expect(ok).toBe(true);
          model.delete(obj);
        }
      }

      // Invariante: höchstens ein aktiver Besitzer je Objekt (public API).
      for (const o of objects) {
        const cur = model.get(o);
        if (cur && cur.leaseUntil <= now) model.delete(o);
        expect(lm.isLocked(o, now)).toBe(model.has(o));
      }
    }
  });

  it('Lease-Expiry gibt Sperren automatisch frei (kein Deadlock)', () => {
    const lm = new LockManager();
    expect(lm.acquire('drum', 'u1', 10, 100)).toBe(true);
    expect(lm.acquire('drum', 'u2', 10, 105)).toBe(false); // aktiv gehalten
    expect(lm.acquire('drum', 'u2', 10, 111)).toBe(true); // abgelaufen → übernommen
    expect(lm.isLocked('drum', 120)).toBe(true); // neue Lease gilt bis 121
    expect(lm.isLocked('drum', 122)).toBe(false); // danach frei
  });
});
