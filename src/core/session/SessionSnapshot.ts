/**
 * audioMONASTRY · 3.1.4 – Session-Persistenz (Snapshot + Delta-Kompression)
 * =========================================================================
 * Server-/Storage-fähige Session-Snapshots für Rejoin-Szenarien. Deltas werden
 * aus dem CRDT-Replikationszustand (1.2.2) abgeleitet und sind damit
 * deterministisch und kompakt (nur geänderte Objekte).
 */
import type { ReplicationEntry, ReplicationState } from './stateReplication';

export interface SessionSnapshot<T = unknown> {
  version: 1;
  sessionId: string;
  /** Vollständiger Objektzustand als Replikationseinträge. */
  entries: ReplicationEntry<T>[];
  createdAt: number;
}

export interface SessionDelta<T = unknown> {
  /** Nur Einträge mit clock > sinceClock. */
  entries: ReplicationEntry<T>[];
  sinceClock: number;
}

/** Erzeugt einen vollständigen Snapshot aus dem Replikationszustand. */
export function createSnapshot<T>(
  sessionId: string,
  state: ReplicationState<T>,
  now = Date.now(),
): SessionSnapshot<T> {
  return { version: 1, sessionId, entries: [...state.values()], createdAt: now };
}

/** Erzeugt ein Delta ab einem Clock-Stand (Kompression). */
export function createDelta<T>(
  state: ReplicationState<T>,
  sinceClock: number,
): SessionDelta<T> {
  return {
    entries: [...state.values()].filter((e) => e.clock > sinceClock),
    sinceClock,
  };
}

/** Wendet ein Delta auf einen Zustand an (idempotent, LWW inkl. Tie-Break). */
export function applyDelta<T>(
  state: ReplicationState<T>,
  delta: SessionDelta<T>,
): void {
  for (const entry of delta.entries) {
    const existing = state.get(entry.objectId);
    if (
      !existing ||
      existing.clock < entry.clock ||
      (existing.clock === entry.clock && existing.peerId < entry.peerId)
    ) {
      state.set(entry.objectId, entry);
    }
  }
}

/** Serialisiert einen Snapshot für Storage/Transport (JSON). */
export function serializeSnapshot<T>(snapshot: SessionSnapshot<T>): string {
  return JSON.stringify(snapshot);
}

/** Deserialisiert einen Snapshot (defensiv). */
export function deserializeSnapshot<T>(raw: string): SessionSnapshot<T> | null {
  try {
    const parsed = JSON.parse(raw) as SessionSnapshot<T>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}
