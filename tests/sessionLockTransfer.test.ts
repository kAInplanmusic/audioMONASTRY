// COLLAB-P0-004 Teil 2: gezielte Uebergabe des Halters.
// Betreiberregel 2026-09-17: der Halter kann mixerMONK weitergeben - danach ist
// der neue Halter der Einzige, der den Main-Sound-Out beeinflusst. Nur der
// AKTUELLE Halter darf uebertragen; es gibt keinen Admin-/Rollen-Fallback.
import { describe, it, expect } from 'vitest';
import { AuthoritativeSession } from '../src/core/session/authoritativeSession';

const MIXER = 'mixer';

describe('AuthoritativeSession.transferLock', () => {
  it('uebertraegt die Lease vom Halter auf den neuen Nutzer', () => {
    const session = new AuthoritativeSession();
    expect(session.acquireLock(MIXER, 'user-a').ok).toBe(true);
    expect(session.lockOwner(MIXER)).toBe('user-a');

    const result = session.transferLock(MIXER, 'user-a', 'user-b');

    expect(result.ok).toBe(true);
    expect(result.lockedBy).toBe('user-b');
    expect(session.lockOwner(MIXER)).toBe('user-b');
  });

  it('nur der aktuelle Halter darf uebertragen', () => {
    const session = new AuthoritativeSession();
    session.acquireLock(MIXER, 'user-a');

    const byOther = session.transferLock(MIXER, 'user-b', 'user-c');

    expect(byOther.ok).toBe(false);
    expect(byOther.reason).toBe('not-owner');
    expect(byOther.lockedBy).toBe('user-a');
    expect(session.lockOwner(MIXER)).toBe('user-a');
  });

  it('ohne Lock gibt es nichts zu uebertragen', () => {
    const session = new AuthoritativeSession();
    const result = session.transferLock(MIXER, 'user-a', 'user-b');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-owner');
    expect(session.lockOwner(MIXER)).toBeNull();
  });

  it('eine Uebergabe an sich selbst ist kein Wechsel', () => {
    const session = new AuthoritativeSession();
    session.acquireLock(MIXER, 'user-a');
    const result = session.transferLock(MIXER, 'user-a', 'user-a');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('same-owner');
    expect(session.lockOwner(MIXER)).toBe('user-a');
  });

  it('leere Angaben werden abgewiesen', () => {
    const session = new AuthoritativeSession();
    session.acquireLock(MIXER, 'user-a');
    for (const [from, to] of [
      ['', 'user-b'],
      ['user-a', ''],
      ['user-a', '   '],
    ]) {
      const result = session.transferLock(MIXER, from, to);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('invalid');
    }
    // Der bestehende Halter bleibt unangetastet.
    expect(session.lockOwner(MIXER)).toBe('user-a');
  });

  it('nach der Uebergabe ist der alte Halter nicht mehr Owner', () => {
    const session = new AuthoritativeSession();
    session.acquireLock(MIXER, 'user-a');
    session.transferLock(MIXER, 'user-a', 'user-b');

    // Der alte Halter kann nicht zurueck-uebertragen (er ist nicht mehr Owner).
    const back = session.transferLock(MIXER, 'user-a', 'user-a2');
    expect(back.ok).toBe(false);
    expect(back.reason).toBe('not-owner');
    // Der neue Halter schon.
    expect(session.transferLock(MIXER, 'user-b', 'user-c').ok).toBe(true);
    expect(session.lockOwner(MIXER)).toBe('user-c');
  });
});
