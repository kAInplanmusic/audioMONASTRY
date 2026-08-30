// ============================================================================
// hubConnector – Zentraler Plugin-Lock-/Freigabe-Service mit RBAC
// ----------------------------------------------------------------------------
// Verdrahtet die B2B-Sperre (Locked Mode) mit dem neuen RBAC-System.
// `lockPlugin`/`unlockPlugin` prüfen die Rollen-Berechtigung (admin/producer
// können sperren) und schreiben Audit-Events. Open Source, kein Vault.
// ============================================================================
import { assertCan, roleForUser, can, Role } from './utils/rbac';
import { logAuditEvent } from './utils/AuditLogger';

interface LockEntry {
  lockedBy: string;
  role: Role;
  timestamp: number;
}

// In-memory Plugin-Lock-Registry (Nur lokale, Single-Host-Session).
const locks: Record<string, LockEntry | null> = {};

export const hubConnector = {
  /** Host der aktuellen Session (für RBAC). Lokale Sessions = 'localUser'. */
  _hostId: 'localUser',

  setHost(hostId: string) {
    this._hostId = hostId;
  },

  /** Sperrt ein Plugin, sofern der User die 'lock'-Berechtigung hat (B2B). */
  async lockPlugin(id: string, userId: string): Promise<boolean> {
    const roomRole = roleForUser(userId, this._hostId);
    const allowed = await assertCan(userId, 'lock', this._hostId, {
      pluginId: id,
      reason: 'lockPlugin versucht, B2B-Sperre zu setzen',
    });
    if (!allowed) return false;

    // Nur sperren, wenn nicht bereits durch einen anderen aktiv gesperrt.
    const existing = locks[id];
    if (existing && existing.lockedBy !== userId) return false;

    locks[id] = { lockedBy: userId, role: roomRole, timestamp: Date.now() };
    await logAuditEvent(userId, 'PLUGIN_LOCK', { plugin: id, role: roomRole });
    return true;
  },

  /** Gibt ein Plugin frei (nur Sperrer selbst oder admin). */
  async unlockPlugin(id: string, userId: string): Promise<boolean> {
    const existing = locks[id];
    // Nicht gesperrt -> bereits frei.
    if (!existing) return true;
    // Fremde Sperre nur durch admin (kick-Level) aufheben.
    if (existing.lockedBy !== userId) {
      const admin = await assertCan(userId, 'unlock', this._hostId, {
        pluginId: id,
        reason: 'unlock fremder Sperre',
      });
      if (!admin) return false;
    }
    locks[id] = null;
    await logAuditEvent(userId, 'PLUGIN_UNLOCK', { plugin: id });
    return true;
  },

  /** Lese-Lock-Status für UI (reactiv über WebRTC/Context gehalten). */
  getLock(id: string): LockEntry | null {
    return locks[id] ?? null;
  },

  isLocked(id: string): boolean {
    const l = locks[id];
    return !!l;
  },
};

// Exports für konsistenten Zugriff (Role etc.)
export type { Role };
export { can };
