/**
 * audioMONASTRY · 1.2.3 – Lease-basiertes Locking (Heartbeat + Auto-Release)
 * ============================================================================
 * Produktionsreifes B2B-Locking für Session-Objekte (Plugins/Module):
 *
 *  - `acquire` sperrt ein Objekt für einen Besitzer mit Lease-Dauer.
 *  - `renew` ist der Heartbeat: verlängert die Lease des Besitzers.
 *  - Abgelaufene Leases werden bei `acquire`/`isLocked`/`expireAll` automatisch
 *    freigegeben → Verbindungsabbruch führt nie zu Deadlocks.
 *  - Alle Methoden nehmen `now` als Parameter (testbar, deterministisch).
 */
export interface LeaseLock {
  objectId: string;
  ownerId: string;
  /** Unix-ms bis wann die Lease gilt. */
  leaseUntil: number;
  /** Anzahl der Heartbeats (Renewals) – für Monitoring. */
  renewals: number;
}

export class LockManager {
  private locks = new Map<string, LeaseLock>();

  /**
   * Sperrt ein Objekt. Liefert `true`, wenn der Besitzer die Sperre hält
   * (neu, erneuert oder Lease übernommen, weil die alte abgelaufen war).
   */
  acquire(objectId: string, ownerId: string, leaseMs: number, now = Date.now()): boolean {
    if (leaseMs <= 0) return false;
    const existing = this.locks.get(objectId);

    // Gleicher Besitzer → Heartbeat-Verlängerung.
    if (existing && existing.ownerId === ownerId) {
      existing.leaseUntil = now + leaseMs;
      existing.renewals += 1;
      return true;
    }

    // Abgelaufene Lease → automatisch freigeben und neu vergeben (kein Deadlock).
    if (existing && existing.leaseUntil > now) {
      return false; // aktiv von anderem Besitzer gehalten
    }

    this.locks.set(objectId, {
      objectId,
      ownerId,
      leaseUntil: now + leaseMs,
      renewals: 0,
    });
    return true;
  }

  /** Heartbeat: verlängert eine bestehende Lease desselben Besitzers. */
  renew(objectId: string, ownerId: string, leaseMs: number, now = Date.now()): boolean {
    const existing = this.locks.get(objectId);
    if (!existing || existing.ownerId !== ownerId) return false;
    if (existing.leaseUntil <= now) {
      // Lease war abgelaufen → Freigabe und Neu-Vergabe an den Heartbeat-Sender.
      this.locks.delete(objectId);
      return this.acquire(objectId, ownerId, leaseMs, now);
    }
    existing.leaseUntil = now + leaseMs;
    existing.renewals += 1;
    return true;
  }

  /** Gibt eine Sperre frei (nur der Besitzer darf das). */
  release(objectId: string, ownerId: string, now = Date.now()): boolean {
    const existing = this.locks.get(objectId);
    if (!existing) return true; // bereits frei
    if (existing.ownerId !== ownerId && existing.leaseUntil > now) return false;
    this.locks.delete(objectId);
    return true;
  }

  /** Ist das Objekt aktuell gesperrt? (gibt abgelaufene Leases frei) */
  isLocked(objectId: string, now = Date.now()): boolean {
    const existing = this.locks.get(objectId);
    if (!existing) return false;
    if (existing.leaseUntil <= now) {
      this.locks.delete(objectId);
      return false;
    }
    return true;
  }

  /** Besitzer eines Objekts (oder `null`, wenn frei/abgelaufen). */
  ownerOf(objectId: string, now = Date.now()): string | null {
    const existing = this.locks.get(objectId);
    if (!existing) return null;
    if (existing.leaseUntil <= now) {
      this.locks.delete(objectId);
      return null;
    }
    return existing.ownerId;
  }

  /** Gibt alle abgelaufenen Leases frei. Liefert die Anzahl freigegebener Locks. */
  expireAll(now = Date.now()): number {
    let released = 0;
    for (const [id, lock] of this.locks) {
      if (lock.leaseUntil <= now) {
        this.locks.delete(id);
        released++;
      }
    }
    return released;
  }

  /** Snapshot aller aktiven Locks (für UI/Session-Export). */
  snapshot(now = Date.now()): LeaseLock[] {
    this.expireAll(now);
    return [...this.locks.values()].map((l) => ({ ...l }));
  }

  /** Anzahl aktiver Locks. */
  get size(): number {
    return this.locks.size;
  }
}

export const lockManager = new LockManager();
