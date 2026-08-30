// ============================================================================
// CRDT-Sync für WebRTC DataChannel (Zero-Desync)
// ----------------------------------------------------------------------------
// Leichtgewichtiges CRDT (keine externe Abhängigkeit):
//   * `CrdtClock` – Lamport-Uhr zur Ereignis-Anordnung (peerId schlichtet Gleichstand)
//   * `CrdtLwwMap` – Last-Writer-Wins-Map für PLUGIN_STATE_UPDATE
//   * `createClockMerger` – Glättungs-/Annehmbar-Schwelle für CLOCK_SYNC
//     (verhindert die 10Hz-Sende-/Empfangsüberlagerung, die zu Positions-
//      springen und Zero-Desync führt)
// ============================================================================

export type CrdtStamp = { t: number; peer: number };

/** Lamport-Uhr: liefert nach jeder Aktion eine streng monoton steigende Stamp. */
export class CrdtClock {
  private t = 0;
  constructor(private peer: number) {}

  tick(seen?: CrdtStamp): CrdtStamp {
    this.t = Math.max(this.t, (seen?.t ?? 0) + 1) + 1;
    return { t: this.t, peer: this.peer };
  }
  get now(): number {
    return this.t;
  }
}

/** Ordnung: nach Zeit, dann nach peerId (deterministisch). */
export function crdtCmp(a: CrdtStamp, b: CrdtStamp): number {
  if (a.t !== b.t) return a.t - b.t;
  return a.peer - b.peer;
}

/** LWW-Map – Konfliktfreier Key->Wert-Zustand mit Determinus-Sieger. */
export class CrdtLwwMap<V> {
  private store = new Map<string, { v: V; stamp: CrdtStamp }>();

  set(key: string, value: V, stamp: CrdtStamp): boolean {
    const prev = this.store.get(key);
    if (prev && crdtCmp(stamp, prev.stamp) <= 0) return false; // älter/gleich => ignoriere
    this.store.set(key, { v: value, stamp });
    return true;
  }
  get(key: string): V | undefined {
    return this.store.get(key)?.v;
  }
  merge(other: CrdtLwwMap<V>): void {
    for (const [k, e] of other.store) this.set(k, e.v, e.stamp);
  }
  snapshot(): Record<string, { value: V; stamp: [number, number] }> {
    const out: Record<string, { value: V; stamp: [number, number] }> = {};
    for (const [k, e] of this.store) out[k] = { value: e.v, stamp: [e.stamp.t, e.stamp.peer] };
    return out;
  }
}

/**
 * Clock-Merger: nimmt potenziell überlagerte (10Hz) Transport-Sekunden an
 * und gibt eine monoton glatt steigende Position aus. Verhindert Desync und
 * rückwärtige Springer durch verspätet ankommende Pakete.
 */
export class CrdtClockMerger {
  private lastAccepted = -Infinity;
  private lastApplied = -Infinity;
  private pending: number | null = null;

  constructor(
    private minStepSec = 0.002,      // 2ms minimaler Vorrück-Schritt
    private maxForwardStep = 4.0,    // Plausibilitätslimit in Sekunden pro Ereignis
  ) {}

  /** Eingehendes Update akzeptieren (kann verworf/verzögert werden). */
  proposed(candidate: number): boolean {
    // Rückwärts (altert, stiller Desync) grundsätzlich verwerfen
    if (candidate < this.lastAccepted) return false;
    // Zu großer Vorwärts-Sprung ist unplausibel -> verwerfen
    if (candidate - this.lastAccepted > this.maxForwardStep) return false;
    this.lastAccepted = candidate;

    // Nur vorrücken, wenn genug Delta (Filtert die 10Hz-Überlagerung, die
    // zwischen zwei Paketen nur wenige Millisekunden auseinanderliegt).
    const delta = candidate - this.lastApplied;
    if (delta >= this.minStepSec) {
      this.lastApplied = candidate;
      this.pending = null;
      return true;
    }
    // Zu klein: als pending vormerken, aber nicht anwenden (Zero-Desync).
    this.pending = candidate;
    return false;
  }

  /** Aktuelle (deterministische) abgeleitete Uhrzeit. */
  get value(): number {
    return this.lastApplied;
  }
  /** true, wenn noch ein unangewendetes (pending) Update vorliegt. */
  hasPending(): boolean {
    return this.pending !== null;
  }
  reset(): void {
    this.lastAccepted = -Infinity;
    this.lastApplied = -Infinity;
    this.pending = null;
  }
}

/** Vorgeschlagene Nachrichtenstruktur über DataChannel (CRDT-bewusst). */
export interface CrdtSyncMessage {
  type: 'CLOCK_SYNC' | 'PLUGIN_STATE_UPDATE';
  stamp: [number, number];         // Lamport-Zeit, Peer
  masterTime?: number;             // CLOCK_SYNC
  masterBpm?: number;
  pluginId?: string;               // PLUGIN_STATE_UPDATE
  state?: unknown;
  revision?: number;
}
