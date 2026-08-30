// ============================================================================
// RBAC – Zentrales Rollen-Berechtigungssystem für audioMONASTRY-Sessions
// ----------------------------------------------------------------------------
// Host + bis zu 4 User. Rollen: admin | producer | engineer | guest.
// Konfiguration über Umgebungsvariablen (Vite) bzw. localStorage-Fallback:
//   SESSION_HOST_USER  – uid des Hosts (erhält immer admin)
//   SESSION_ROLE       – default-Rolle für nicht-Host-Teilnehmer
// Nur Open Source, kein Vault/Firestore.
// ============================================================================
import { logAuditEvent } from './AuditLogger';
import { storageGet } from './storage';

export type Role = 'admin' | 'producer' | 'engineer' | 'guest';

/** Semantische Aktionen, die über Module hinweg geprüft werden. */
export type Action =
  | 'lock'      // Plugin sperren (B2B-Lock für sich)
  | 'unlock'    // Plugin wieder freigeben
  | 'edit'      // Parameter eines Plugins ändern (nicht gesperrt)
  | 'master'    // Mastering-/Summing-Kette bedienen
  | 'state'     // Plugin-Zustand togglen (OFF/AI/PRO)
  | 'routing'   // Audio-Routing / Monitor-Cue ändern
  | 'kick'      // User aus der Session entfernen
  | 'assign'    // Rolle eines Teilnehmers setzen;

const ROLE_LEVEL: Record<Role, number> = { guest: 0, engineer: 1, producer: 2, admin: 3 };

const ACTION_MIN: Record<Action, Role> = {
  lock: 'producer',
  unlock: 'producer',
  edit: 'producer',
  master: 'engineer',
  state: 'guest',
  routing: 'engineer',
  kick: 'admin',
  assign: 'admin',
};

export const ROLES: Role[] = ['admin', 'producer', 'engineer', 'guest'];

/** Liest die Session-Rollen-Konfiguration (Storage-Fallback). */
export function readSessionConfig(): { hostUid: string; defaultRole: Role } {
  let hostUid = '';
  let defaultRole: Role = 'guest';
  try {
    hostUid = storageGet('SESSION_HOST_USER') || '';
    const r = storageGet('SESSION_ROLE');
    if (r && ROLES.includes(r as Role)) defaultRole = r as Role;
  } catch { /* ignore */ }
  return { hostUid, defaultRole };
}

/** Bestimmt die Rolle eines Users in der Session. Host ist immer admin. */
export function roleForUser(userId: string, roomHostId?: string | null): Role {
  if (roomHostId && userId === roomHostId) return 'admin';
  const { hostUid, defaultRole } = readSessionConfig();
  if (hostUid && userId === hostUid) return 'admin';
  return defaultRole;
}

export function can(role: Role, action: Action): boolean {
  const need = ACTION_MIN[action];
  return ROLE_LEVEL[role] >= ROLE_LEVEL[need];
}

/**
 * Prüft eine Aktion und loggt bei Verweigerung ein Audit-Event.
 * Gibt true zurück, wenn erlaubt.
 */
export async function assertCan(
  userId: string,
  action: Action,
  roomHostId?: string | null,
  context?: { pluginId?: string; reason?: string },
): Promise<boolean> {
  const role = roleForUser(userId, roomHostId);
  const ok = can(role, action);
  if (!ok) {
    await logAuditEvent(userId, `RBAC_DENIED`, {
      action,
      role,
      pluginId: context?.pluginId,
      reason: context?.reason ?? `role '${role}' hat nicht '${action}'`,
    });
  }
  return ok;
}

export { logAuditEvent };

// ============================================================================
// 3.2.1 – Dynamisches Rollensystem (Composition + Inheritance)
// ============================================================================
export interface RoleDefinition {
  name: string;
  level: number;
  inherits?: string[];
  /** Erlaubte Aktionen (additiv zur Vererbung). */
  grants: Action[];
}

const customRoles = new Map<string, RoleDefinition>();

/** Definiert eine benutzerdefinierte Rolle ohne Code-Änderung. */
export function defineRole(def: RoleDefinition): void {
  customRoles.set(def.name, def);
}

/** Effektive Stufe einer Rolle (inkl. Vererbung). */
export function roleLevel(role: string): number {
  const def = customRoles.get(role);
  if (def) {
    const inherited = (def.inherits ?? [])
      .map((r) => roleLevel(r))
      .reduce((max, v) => Math.max(max, v), 0);
    return Math.max(def.level, inherited);
  }
  return ROLE_LEVEL[role as Role] ?? 0;
}

/** Erweiterte Berechtigungsprüfung mit dynamischen Rollen. */
export function canDynamic(role: string, action: Action): boolean {
  const def = customRoles.get(role);
  if (def) {
    if (def.grants.includes(action)) return true;
    for (const parent of def.inherits ?? []) {
      if (canDynamic(parent, action)) return true;
    }
  }
  return roleLevel(role) >= ROLE_LEVEL[ACTION_MIN[action]];
}

// ============================================================================
// 3.2.2 – Modul-Level-Permissions (pro Modul, pro Parameter)
// ============================================================================
export interface ModulePermission {
  moduleId: string;
  /** read | write | full */
  access: 'read' | 'write' | 'full';
  /** Optionale Parameter-Whitelist (leer = alle). */
  params?: string[];
}

const modulePermissions = new Map<string, Record<string, ModulePermission>>();

/** Setzt eine Modul-Berechtigung für eine Rolle. */
export function setModulePermission(role: string, permission: ModulePermission): void {
  const perRole = modulePermissions.get(role) ?? {};
  perRole[permission.moduleId] = permission;
  modulePermissions.set(role, perRole);
}

/** Prüft, ob eine Rolle ein Modul (und optional einen Parameter) bedienen darf. */
export function canAccessModule(role: string, moduleId: string, param?: string, write = true): boolean {
  const perm = modulePermissions.get(role)?.[moduleId];
  if (!perm) return canDynamic(role, write ? 'edit' : 'state');
  if (perm.access === 'full') return true;
  if (write && perm.access !== 'write') return false;
  if (param && perm.params && !perm.params.includes(param)) return false;
  return true;
}

// ============================================================================
// 3.2.3 – Echtzeit-Rollenwechsel (ohne Audio-Unterbrechung)
// ============================================================================
export interface RoleTransition {
  from: string;
  to: string;
  at: number;
  /** 0..1 Fortschritt (progressive Permission-Updates mit Fade). */
  progress: number;
}

export class RoleTransitionManager {
  private current = new Map<string, string>();
  private transitions = new Map<string, RoleTransition>();
  private onTransition: (userId: string, t: RoleTransition) => void = () => {};

  onRoleTransition(cb: (userId: string, t: RoleTransition) => void): void {
    this.onTransition = cb;
  }

  /**
   * Startet einen progressiven Rollenwechsel. Die Audio-Engine läuft
   * ununterbrochen weiter; Permissions werden schrittweise umgestellt.
   */
  beginTransition(userId: string, to: string, durationMs = 500): void {
    const from = this.current.get(userId) ?? 'guest';
    const t: RoleTransition = { from, to, at: Date.now(), progress: 0 };
    this.transitions.set(userId, t);
    const started = Date.now();
    const timer = setInterval(() => {
      const p = Math.min(1, (Date.now() - started) / durationMs);
      t.progress = p;
      this.onTransition(userId, { ...t });
      if (p >= 1) {
        clearInterval(timer);
        this.transitions.delete(userId);
        this.current.set(userId, to);
      }
    }, 50);
  }

  activeRole(userId: string): string {
    return this.current.get(userId) ?? 'guest';
  }

  pending(userId: string): RoleTransition | undefined {
    return this.transitions.get(userId);
  }
}

export const roleTransitionManager = new RoleTransitionManager();
