/**
 * audioMONASTRY · 1.2.2 – Deterministisches State-Replication-Protokoll (CRDT)
 * ============================================================================
 * LWW-Register + OR-Set für versionierte Session-Objekte (siehe 1.2.1):
 *
 *  - Jede Änderung erzeugt einen `ReplicationEntry` mit logischer Uhr
 *    (Lamport-Clock) und Absender-ID.
 *  - `mergeEntries` konvergiert zwei Replicas deterministisch: pro Objekt
 *    gewinnt der Eintrag mit höherer Uhr, bei Gleichstand die höhere Absender-ID.
 *  - Löschungen werden als Tombstones (`data: null`) repliziert und sind
 *    idempotent – Offline-Änderungen konvergieren bei Reconnect verlustfrei.
 *  - Kein Code darf `Date.now()` für die Konfliktlösung verwenden (Wanduhr
 *    ist nicht monoton); nur die logische Uhr zählt.
 */
import type { SessionObject } from './ObjectRegistry';

export interface ReplicationEntry<T = unknown> {
  /** Objekt-ID (Referenz auf ObjectRegistry). */
  objectId: string;
  type: string;
  /** Lamport-Clock-Wert des Absenders. */
  clock: number;
  /** Stabile Absender-/Peer-ID (für deterministische Tie-Breaks). */
  peerId: string;
  /** `null` = Tombstone (Löschung). */
  data: T | null;
  version: number;
}

export type ReplicationState<T = unknown> = Map<string, ReplicationEntry<T>>;

export class LamportClock {
  private value = 0;

  constructor(private peerId: string) {}

  /** Lokale Uhr hochzählen und Zeitstempel liefern. */
  tick(): number {
    this.value += 1;
    return this.value;
  }

  /** Fremden Uhrwert übernehmen (max) und weiterzählen. */
  observe(remoteClock: number): number {
    this.value = Math.max(this.value, remoteClock) + 1;
    return this.value;
  }

  get current(): number {
    return this.value;
  }
}

/** Erzeugt einen Replikationseintrag für ein Session-Objekt. */
export function entryForObject<T>(clock: LamportClock, obj: SessionObject<T>): ReplicationEntry<T> {
  return {
    objectId: obj.id,
    type: obj.type,
    clock: clock.tick(),
    peerId: clockPeerId(clock),
    data: obj.data,
    version: obj.version,
  };
}

/** Erzeugt einen Tombstone-Eintrag (Löschung). */
export function tombstoneFor<T>(clock: LamportClock, objectId: string, type: string): ReplicationEntry<T> {
  return {
    objectId,
    type,
    clock: clock.tick(),
    peerId: clockPeerId(clock),
    data: null,
    version: 0,
  };
}

function clockPeerId(clock: LamportClock): string {
  return (clock as unknown as { peerId: string }).peerId;
}

/**
 * Führt einen fremden Eintrag in den lokalen Zustand ein (idempotent).
 * LWW-Regel: höhere Uhr gewinnt; bei Gleichstand gewinnt die lexikografisch
 * größere Absender-ID. Tombstones überschreiben ältere Daten.
 */
export function mergeEntry<T>(
  state: ReplicationState<T>,
  entry: ReplicationEntry<T>,
): boolean {
  const existing = state.get(entry.objectId);
  if (
    existing &&
    (existing.clock > entry.clock ||
      (existing.clock === entry.clock && existing.peerId >= entry.peerId))
  ) {
    return false; // lokaler Zustand ist neuer/gewinnt den Tie-Break
  }
  state.set(entry.objectId, { ...entry });
  return true;
}

/** Führt mehrere Einträge deterministisch zusammen (Reihenfolge egal). */
export function mergeEntries<T>(
  state: ReplicationState<T>,
  entries: Iterable<ReplicationEntry<T>>,
): number {
  let applied = 0;
  for (const entry of entries) {
    if (mergeEntry(state, entry)) applied++;
  }
  return applied;
}

/**
 * Wendet den replizierten Zustand auf eine ObjectRegistry an.
 * Liefert die Anzahl tatsächlich veränderter Objekte.
 */
export function applyReplicationToRegistry<T>(
  registry: {
    applyReplicated(id: string, type: string, data: T, version: number): SessionObject<T>;
    update(id: string, data: T): SessionObject<T> | undefined;
    delete(id: string): boolean;
    has(id: string): boolean;
  },
  state: ReplicationState<T>,
): number {
  let changed = 0;
  for (const entry of state.values()) {
    if (entry.data === null) {
      if (registry.has(entry.objectId) && registry.delete(entry.objectId)) changed++;
      continue;
    }
    if (registry.has(entry.objectId)) {
      if (registry.update(entry.objectId, entry.data)) changed++;
    } else {
      registry.applyReplicated(entry.objectId, entry.type, entry.data, entry.version);
      changed++;
    }
  }
  return changed;
}

/**
 * Zwei Replica-Zustände konvergieren (symmetrischer Merge).
 * Ergebnis ist unabhängig von der Reihenfolge.
 */
export function converge<T>(a: ReplicationState<T>, b: ReplicationState<T>): ReplicationState<T> {
  const out: ReplicationState<T> = new Map();
  mergeEntries(out, a.values());
  mergeEntries(out, b.values());
  return out;
}
