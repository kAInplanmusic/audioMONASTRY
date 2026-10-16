import { describe, expect, it } from 'vitest';
import {
  AuthoritativeSession,
  MemorySessionPersistence,
  type SessionEventInput,
} from '../src/core/session/authoritativeSession';

// ---------------------------------------------------------------------------
// COLLAB-P0-001: serverautoritativer Session-State. Hier wird die Wirkung
// geprüft, nicht nur „läuft": Revision, Duplikat-/Stale-Verwerfung, atomare
// Locks, Snapshot und Redis-Recovery (serialize/restore).
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const ev = (partial: Partial<SessionEventInput> & Pick<SessionEventInput, 'id' | 'senderUserId'>): SessionEventInput => ({
  type: 'plugin-state',
  pluginId: 'mixer',
  state: 'PRO',
  ...partial,
});

describe('AuthoritativeSession – Revision/Sequenz/Dedupe', () => {
  it('erhöht die Revision nur bei akzeptierten Events', () => {
    const s = new AuthoritativeSession();
    expect(s.revision).toBe(0);
    const r1 = s.applyEvent(ev({ id: 'e1', senderUserId: 'u1', sequence: 1 }), T0);
    expect(r1).toEqual({ accepted: true, revision: 1 });
    const r2 = s.applyEvent(ev({ id: 'e2', senderUserId: 'u1', sequence: 2 }), T0);
    expect(r2).toEqual({ accepted: true, revision: 2 });
    expect(s.revision).toBe(2);
  });

  it('verwirft doppelte Event-IDs (auch bei höherer Sequenz)', () => {
    const s = new AuthoritativeSession();
    expect(s.applyEvent(ev({ id: 'same', senderUserId: 'u1', sequence: 1 }), T0).accepted).toBe(true);
    const dup = s.applyEvent(ev({ id: 'same', senderUserId: 'u1', sequence: 2 }), T0);
    expect(dup).toEqual({ accepted: false, reason: 'duplicate', revision: 1 });
  });

  it('verwirft verspätete Events je Sender (Sequenz <= letzte)', () => {
    const s = new AuthoritativeSession();
    s.applyEvent(ev({ id: 'a1', senderUserId: 'u1', sequence: 5 }), T0);
    expect(s.applyEvent(ev({ id: 'a2', senderUserId: 'u1', sequence: 4 }), T0).reason).toBe('stale-sequence');
    expect(s.applyEvent(ev({ id: 'a3', senderUserId: 'u1', sequence: 5 }), T0).reason).toBe('stale-sequence');
    // Höhere Sequenz geht weiter; andere Sender haben eigene Sequenzen.
    expect(s.applyEvent(ev({ id: 'a4', senderUserId: 'u1', sequence: 6 }), T0).accepted).toBe(true);
    expect(s.applyEvent(ev({ id: 'b1', senderUserId: 'u2', sequence: 1 }), T0).accepted).toBe(true);
  });

  it('verwirft unvollständige Events', () => {
    const s = new AuthoritativeSession();
    expect(s.applyEvent({ id: '', type: 'plugin-state', senderUserId: 'u1' } as SessionEventInput, T0).reason).toBe('invalid');
    expect(s.applyEvent({ id: 'x', type: '', senderUserId: 'u1' } as SessionEventInput, T0).reason).toBe('invalid');
    expect(s.applyEvent({ id: 'x', type: 'plugin-state', senderUserId: '' } as SessionEventInput, T0).reason).toBe('invalid');
    expect(s.revision).toBe(0);
  });

  it('hält den Modul-State je Plugin mit Revision und User fest', () => {
    const s = new AuthoritativeSession();
    s.applyEvent(ev({ id: 'm1', senderUserId: 'u1', pluginId: 'eq', state: 'AUTO_AI' }), T0);
    const snap = s.snapshot(T0);
    expect(snap.modules.eq).toEqual({ state: 'AUTO_AI', revision: 1, updatedBy: 'u1' });
    expect(snap.revision).toBe(1);
  });

  it('4 parallele User: alle akzeptiert, Replays werden deterministisch verworfen', () => {
    const s = new AuthoritativeSession();
    const users = ['u1', 'u2', 'u3', 'u4'];
    const events: SessionEventInput[] = [];
    users.forEach((u, ui) => {
      for (let seq = 1; seq <= 5; seq++) {
        events.push(ev({ id: `${u}-${seq}`, senderUserId: u, sequence: seq, pluginId: `plug${ui}`, state: seq % 2 ? 'PRO' : 'AUTO_AI' }));
      }
    });
    // Bewusst verschränkt anwenden (Round-Robin).
    for (let round = 0; round < 5; round++) {
      for (const u of users) {
        const e = events.find((x) => x.id === `${u}-${round + 1}`);
        expect(e && s.applyEvent(e, T0).accepted, `${u}-${round + 1}`).toBe(true);
      }
    }
    expect(s.revision).toBe(20);
    // Replay aller Events (Duplikate) → alle abgelehnt, Revision bleibt.
    for (const e of events) expect(s.applyEvent(e, T0).accepted).toBe(false);
    expect(s.revision).toBe(20);
    const snap = s.snapshot(T0);
    expect(Object.keys(snap.modules)).toHaveLength(4);
    expect(snap.sequences).toEqual({ u1: 5, u2: 5, u3: 5, u4: 5 });
  });
});

describe('AuthoritativeSession – atomare Locks', () => {
  it('gibt denselben Lock nicht an einen zweiten User', () => {
    const s = new AuthoritativeSession({ lockTtlMs: 10_000 });
    expect(s.acquireLock('mixer', 'u1', T0)).toEqual({ ok: true });
    expect(s.acquireLock('mixer', 'u2', T0)).toEqual({ ok: false, lockedBy: 'u1' });
    // Heartbeat desselben Halters verlängert (kein Fehlschlag).
    expect(s.acquireLock('mixer', 'u1', T0 + 5_000).ok).toBe(true);
  });

  it('blockiert plugin-state eines fremden Users, erlaubt es dem Halter', () => {
    const s = new AuthoritativeSession({ lockTtlMs: 10_000 });
    s.acquireLock('mixer', 'u1', T0);
    const denied = s.applyEvent(ev({ id: 'x1', senderUserId: 'u2' }), T0);
    expect(denied).toEqual({ accepted: false, reason: 'locked-by-other', revision: 0, lockedBy: 'u1' });
    expect(s.applyEvent(ev({ id: 'x2', senderUserId: 'u1' }), T0).accepted).toBe(true);
    // Nach Freigabe darf u2 schreiben.
    expect(s.releaseLock('mixer', 'u1', T0)).toBe(true);
    expect(s.applyEvent(ev({ id: 'x3', senderUserId: 'u2' }), T0).accepted).toBe(true);
  });

  it('gibt abgelaufene Leases frei und meldet sie für den Broadcast', () => {
    const s = new AuthoritativeSession({ lockTtlMs: 1_000 });
    s.acquireLock('mixer', 'u1', T0);
    expect(s.sweepExpiredLocks(T0 + 500)).toEqual([]);
    expect(s.lockOwner('mixer', T0 + 500)).toBe('u1');
    expect(s.sweepExpiredLocks(T0 + 1_001)).toEqual(['mixer']);
    expect(s.lockOwner('mixer', T0 + 1_001)).toBeNull();
    // Danach kann ein anderer User übernehmen (kein Deadlock).
    expect(s.acquireLock('mixer', 'u2', T0 + 1_001).ok).toBe(true);
  });

  it('gibt beim Disconnect alle Locks eines Users frei', () => {
    const s = new AuthoritativeSession({ lockTtlMs: 10_000 });
    s.acquireLock('mixer', 'u1', T0);
    s.acquireLock('eq', 'u1', T0);
    s.acquireLock('dsp', 'u2', T0);
    expect(s.releaseUserLocks('u1', T0).sort()).toEqual(['eq', 'mixer']);
    expect(s.lockOwner('dsp', T0)).toBe('u2');
    expect(s.snapshot(T0).locks).toHaveLength(1);
  });
});

describe('AuthoritativeSession – Snapshot und Redis-Recovery', () => {
  it('serialisiert und stellt Revision/Locks/State/Sequenzen/Dedupe wieder her', () => {
    const s = new AuthoritativeSession({ lockTtlMs: 60_000 });
    s.applyEvent(ev({ id: 'e1', senderUserId: 'u1', sequence: 3, pluginId: 'eq', state: 'PRO' }), T0);
    s.acquireLock('mixer', 'u2', T0);

    const restored = AuthoritativeSession.restore(s.serialize(T0 + 1_000), { lockTtlMs: 60_000 });
    expect(restored.revision).toBe(1);
    const snap = restored.snapshot(T0 + 1_000);
    expect(snap.modules.eq).toEqual({ state: 'PRO', revision: 1, updatedBy: 'u1' });
    expect(snap.locks.map((l) => l.objectId)).toEqual(['mixer']);
    expect(snap.sequences).toEqual({ u1: 3 });
    // Duplikat bleibt nach dem Restore ein Duplikat.
    expect(restored.applyEvent(ev({ id: 'e1', senderUserId: 'u1', sequence: 9 }), T0 + 1_000).reason).toBe('duplicate');
    // Lock bleibt nach dem Restore aktiv.
    expect(restored.applyEvent(ev({ id: 'e2', senderUserId: 'u3' }), T0 + 1_000).reason).toBe('locked-by-other');
  });

  it('Memory-Persistenz: Serverneustart verliert keinen State', async () => {
    const persistence = new MemorySessionPersistence();
    const before = new AuthoritativeSession({ lockTtlMs: 60_000 });
    before.applyEvent(ev({ id: 'e1', senderUserId: 'u1', sequence: 1, pluginId: 'eq', state: 'AUTO_AI' }), T0);
    before.acquireLock('effect', 'u1', T0);
    await persistence.save(before.serialize(T0));

    // „Neustart": neuer Store, Zustand aus der Persistenz geladen.
    const loaded = await persistence.load();
    const after = AuthoritativeSession.restore(loaded!, { lockTtlMs: 60_000 });
    expect(after.revision).toBe(1);
    expect(after.snapshot(T0).modules.eq?.state).toBe('AUTO_AI');
    expect(after.lockOwner('effect', T0)).toBe('u1');
  });

  it('restore toleriert kaputte/fehlende Daten ohne Absturz', () => {
    const s = AuthoritativeSession.restore({ version: 2 } as never);
    expect(s.revision).toBe(0);
    const t = AuthoritativeSession.restore({
      version: 1,
      revision: -5,
      locks: [{ objectId: 'x', ownerId: 'u1', leaseUntil: T0 + 1000, renewals: 0 }, null as never],
      modules: [['eq', { state: 'PRO', revision: 1, updatedBy: 'u1' }]],
      sequences: [],
      recentEventIds: [],
    });
    expect(t.revision).toBe(0);
    expect(t.lockOwner('x', T0)).toBe('u1');
  });
});

// ---------------------------------------------------------------------------
// COLLAB-P0-001 (Nachtrag): optimistische Nebenlaeufigkeit. Vorher fehlte der
// Vergleich der Basisrevision vollstaendig — zwei Clients, die denselben Stand
// gesehen hatten, konnten sich gegenseitig still ueberschreiben.
// ---------------------------------------------------------------------------
describe('AuthoritativeSession – Basisrevision (optimistische Nebenlaeufigkeit)', () => {
  it('akzeptiert ein Event auf der aktuellen Revision', () => {
    const s = new AuthoritativeSession();
    expect(s.applyEvent(ev({ id: 'b1', senderUserId: 'u1', baseRevision: 0 }), T0))
      .toEqual({ accepted: true, revision: 1 });
    expect(s.applyEvent(ev({ id: 'b2', senderUserId: 'u2', baseRevision: 1 }), T0))
      .toEqual({ accepted: true, revision: 2 });
  });

  it('verwirft ein Event auf veralteter Basis ohne Mutation und meldet den kanonischen Stand', () => {
    const s = new AuthoritativeSession();
    s.applyEvent(ev({ id: 'c1', senderUserId: 'u1', baseRevision: 0 }), T0);
    expect(s.revision).toBe(1);

    const stale = s.applyEvent(
      ev({ id: 'c2', senderUserId: 'u2', state: 'OFF', baseRevision: 0 }),
      T0,
    );
    expect(stale).toEqual({ accepted: false, reason: 'stale-base-revision', revision: 1 });
    // Keine Mutation: Revision unveraendert, fremder Stand nicht uebernommen.
    expect(s.revision).toBe(1);
    expect(s.snapshot(T0).modules.mixer?.state).toBe('PRO');
    expect(s.snapshot(T0).modules.mixer?.updatedBy).toBe('u1');
  });

  it('zwei Absender auf derselben Basis: genau EINER gewinnt, der andere bekommt einen Resync', () => {
    const s = new AuthoritativeSession();
    // Beide haben Revision 0 gesehen (z. B. beide frisch gejoint).
    const first = s.applyEvent(ev({ id: 'd1', senderUserId: 'u1', baseRevision: 0 }), T0);
    const second = s.applyEvent(ev({ id: 'd2', senderUserId: 'u2', baseRevision: 0 }), T0);

    expect(first.accepted).toBe(true);
    expect(second).toEqual({ accepted: false, reason: 'stale-base-revision', revision: 1 });
    // Der Verlierer kann mit der zurueckgegebenen Revision neu aufsetzen.
    expect(s.applyEvent(ev({ id: 'd3', senderUserId: 'u2', baseRevision: second.revision }), T0).accepted).toBe(true);
  });

  it('ohne baseRevision bleibt das Altverhalten erhalten', () => {
    const s = new AuthoritativeSession();
    expect(s.applyEvent(ev({ id: 'e1', senderUserId: 'u1' }), T0).accepted).toBe(true);
    // Kein Feld -> keine Basispruefung, auch wenn inzwischen geschrieben wurde.
    expect(s.applyEvent(ev({ id: 'e2', senderUserId: 'u2' }), T0).accepted).toBe(true);
  });

  it('4 parallele User: die Basispruefung verhindert verlorene Zusagen', () => {
    const s = new AuthoritativeSession();
    // Alle vier bauen auf derselben Revision 0 auf.
    const results = ['u1', 'u2', 'u3', 'u4'].map((u, i) =>
      s.applyEvent(ev({ id: `f${i}`, senderUserId: u, baseRevision: 0 }), T0),
    );
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    expect(results.filter((r) => r.reason === 'stale-base-revision')).toHaveLength(3);
    expect(s.revision).toBe(1);
    // Jeder abgelehnte User kennt danach die kanonische Revision.
    expect(results.every((r) => r.revision === 1)).toBe(true);
  });

  it('ein Schreibvorgang an einem ANDEREN Plugin macht meine Basis NICHT veraltet', () => {
    // Der Kern der Per-Plugin-Basis: der globale Zaehler steigt durch FREMD-
    // Schreibvorgaenge an anderen Plugins. Wuerde dagegen verglichen, lehnte der
    // Server hier ab, obwohl gar kein Konflikt vorliegt — bei vier Nutzern der
    // Normalfall und reines Resync-Rauschen.
    const s = new AuthoritativeSession();
    s.applyEvent(ev({ id: 'g1', senderUserId: 'u1', pluginId: 'eq', baseRevision: 0 }), T0);
    // u4 baut weiterhin auf dem Stand von 'eq' (Revision 1) auf …
    const eqBase = s.snapshot(T0).modules.eq?.revision;
    expect(eqBase).toBe(1);

    // … waehrend ein anderer Nutzer ein ANDERES Plugin schreibt (global -> 2).
    expect(s.applyEvent(ev({ id: 'g2', senderUserId: 'u2', pluginId: 'delay', baseRevision: 0 }), T0).accepted).toBe(true);
    expect(s.revision).toBe(2);

    // Der Send an 'eq' mit der alten 'eq'-Basis ist trotzdem gueltig.
    const ok = s.applyEvent(ev({ id: 'g3', senderUserId: 'u4', pluginId: 'eq', baseRevision: 1 }), T0);
    expect(ok).toEqual({ accepted: true, revision: 3 });
  });

  it('ein Schreibvorgang am SELBEN Plugin macht die Basis veraltet', () => {
    const s = new AuthoritativeSession();
    s.applyEvent(ev({ id: 'h1', senderUserId: 'u1', pluginId: 'eq', baseRevision: 0 }), T0);
    // Ein zweiter Nutzer schreibt dasselbe Plugin -> meine Basis (1) ist alt.
    const stale = s.applyEvent(ev({ id: 'h2', senderUserId: 'u2', pluginId: 'eq', baseRevision: 0 }), T0);
    expect(stale).toEqual({ accepted: false, reason: 'stale-base-revision', revision: 1 });
    // Mit der zurueckgegebenen Revision geht es weiter.
    expect(s.applyEvent(ev({ id: 'h3', senderUserId: 'u2', pluginId: 'eq', baseRevision: stale.revision }), T0).accepted).toBe(true);
  });
});
