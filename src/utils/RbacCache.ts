/**
 * audioMONASTRY · RBAC-Cache mit Lease (AM-E3-2)
 * ==============================================
 * Hält Rollen-/Berechtigungs-Entscheidungen im Speicher, damit der
 * Audio-/Echtzeit-Pfad keine fetch/Token-Refresh-Aufrufe macht.
 */

export interface RbacCacheEntry {
  userId: string;
  role: string;
  permissions: string[];
  expiresAt: number;
}

export class RbacCache {
  private entries = new Map<string, RbacCacheEntry>();

  constructor(private ttlMs = 30_000) {}

  set(entry: RbacCacheEntry): void {
    this.entries.set(entry.userId, entry);
  }

  get(userId: string, now = Date.now()): RbacCacheEntry | null {
    const e = this.entries.get(userId);
    if (!e) return null;
    if (e.expiresAt <= now) {
      this.entries.delete(userId);
      return null;
    }
    return e;
  }

  /** Lease erneuern (Sliding Window). */
  touch(userId: string, now = Date.now()): boolean {
    const e = this.entries.get(userId);
    if (!e || e.expiresAt <= now) return false;
    e.expiresAt = now + this.ttlMs;
    return true;
  }

  can(userId: string, permission: string, now = Date.now()): boolean {
    const e = this.get(userId, now);
    return !!e && e.permissions.includes(permission);
  }

  clear(): void {
    this.entries.clear();
  }
}
