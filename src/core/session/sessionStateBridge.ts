/**
 * audioMONASTRY · Session-State-Bridge (COLLAB-P0-002, Reconnect ohne Pumping)
 * ============================================================================
 * Der Server liefert bei Join/Resync einen autoritativen Snapshot
 * (`session-state`: `revision`, `modules`, `locks`, `sequences`, `serverTime`).
 * Bisher hat KEIN Client diesen Snapshot konsumiert – nach einem Reload wäre
 * der Modul-Zustand deshalb verloren, obwohl der Server ihn kennt.
 *
 * Dieses Modul ist die reine, dependency-freie Übersetzung des Snapshot-
 * Payloads in die Client-Formate (Modul-States + Lock-Status). Validierung
 * ist bewusst defensiv: unbekannte/ungültige Einträge werden übersprungen,
 * ein kaputter Payload ergibt `null` (Aufrufer lässt dann alles unverändert).
 */

export type BridgeModuleState = 'OFF' | 'AUTO_AI' | 'PRO';

interface BridgeLockStatus {
  lockedBy: string;
  timestamp: number;
  active: boolean;
  ttl: number;
}

export interface ParsedSessionSnapshot {
  revision: number;
  serverTime: number;
  modules: Record<string, BridgeModuleState>;
  locks: Record<string, BridgeLockStatus>;
}

const VALID_MODULE_STATES: ReadonlySet<string> = new Set(['OFF', 'AUTO_AI', 'PRO']);
const MAX_PLUGIN_ID_LENGTH = 64;

function sanitizePluginId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_PLUGIN_ID_LENGTH) : '';
}

/**
 * Übersetzt den rohen `session-state`-Payload des Servers in Client-Formate.
 * Gibt `null` zurück, wenn der Payload strukturell unbrauchbar ist.
 */
export function parseSessionSnapshot(raw: unknown): ParsedSessionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const revision = Number(obj.revision);
  const serverTime = Number(obj.serverTime);
  if (!Number.isFinite(revision) || revision < 0) return null;

  const modules: Record<string, BridgeModuleState> = {};
  if (obj.modules && typeof obj.modules === 'object') {
    for (const [pluginId, entry] of Object.entries(obj.modules as Record<string, unknown>)) {
      const id = sanitizePluginId(pluginId);
      if (!id) continue;
      if (!entry || typeof entry !== 'object') continue;
      const state = (entry as Record<string, unknown>).state;
      if (typeof state !== 'string' || !VALID_MODULE_STATES.has(state)) continue;
      modules[id] = state as BridgeModuleState;
    }
  }

  const locks: Record<string, BridgeLockStatus> = {};
  if (Array.isArray(obj.locks)) {
    const now = Date.now();
    for (const entry of obj.locks as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const lock = entry as Record<string, unknown>;
      const id = sanitizePluginId(lock.objectId);
      const ownerId = typeof lock.ownerId === 'string' ? lock.ownerId.trim() : '';
      const leaseUntil = Number(lock.leaseUntil);
      if (!id || !ownerId || !Number.isFinite(leaseUntil) || leaseUntil <= now) continue;
      locks[id] = {
        lockedBy: ownerId,
        timestamp: now,
        active: true,
        ttl: Math.max(1_000, leaseUntil - now),
      };
    }
  }

  return {
    revision,
    serverTime: Number.isFinite(serverTime) ? serverTime : 0,
    modules,
    locks,
  };
}
