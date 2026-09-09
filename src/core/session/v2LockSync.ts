/**
 * audioMONASTRY · V2 Lock/RBAC-Sync (Phase 6)
 * ===========================================
 * Reine, plattformfreie Synchronisation zwischen V2-Session-State und dem
 * bestehenden Lease-basierten Locking (`core/session/locking.ts`).
 *
 * Kernidee: Beim Import eines entfernten V2-GraphState darf ein Teilnehmer nur
 * die Objekte übernehmen, die er besitzt bzw. für die seine Rolle die
 * Berechtigung besitzt. Fremde, aktive Locks bleiben unangetastet.
 */
import type { LeaseLock } from './locking';
import type { AudioGraphState } from '../../utils/audioGraphSerialization';
import { ALL_TRACKS, type TrackType } from '../../types';

export type V2Role = 'admin' | 'producer' | 'engineer' | 'guest';
export type V2Action = 'edit' | 'master' | 'routing' | 'state';

export type V2GraphObjectKind = 'graph' | 'channel' | 'monitor' | 'plugin';

const ROLE_LEVEL: Record<V2Role, number> = { guest: 0, engineer: 1, producer: 2, admin: 3 };

const ACTION_MIN: Record<V2Action, V2Role> = {
  edit: 'producer',
  master: 'engineer',
  routing: 'engineer',
  state: 'guest',
};

export function v2Can(role: V2Role, action: V2Action): boolean {
  return ROLE_LEVEL[role] >= ROLE_LEVEL[ACTION_MIN[action]];
}

/** Stabile Objekt-ID für V2-Session-Locks. */
export function v2ObjectId(kind: V2GraphObjectKind, id?: string): string {
  if (!id) return `v2:${kind}`;
  return `v2:${kind}:${id}`;
}

export interface V2RbacApplyResult {
  /** Übernommener Zustand (basierend auf `current` + erlaubten Feldern aus `incoming`). */
  state: AudioGraphState;
  allowedChannels: TrackType[];
  deniedChannels: TrackType[];
  deniedMaster: boolean;
}

function cloneState(state: AudioGraphState): AudioGraphState {
  return JSON.parse(JSON.stringify(state)) as AudioGraphState;
}

function isChannelLockedByOther(
  locks: readonly LeaseLock[],
  track: TrackType,
  actorId: string,
  now: number,
): boolean {
  const lock = locks.find((l) => l.objectId === v2ObjectId('channel', track));
  return Boolean(lock && lock.ownerId !== actorId && lock.leaseUntil > now);
}

/**
 * Wendet einen entfernten V2-GraphState auf den lokalen State an, wobei
 * Locks und RBAC berücksichtigt werden.
 *
 * - Fremde, aktive Kanal-Locks blockieren den Import dieses Kanals (außer admin).
 * - Kanal-Änderungen brauchen `edit` (producer) oder `routing` (engineer).
 * - Master-/Summing-Änderungen brauchen `master` (engineer+).
 */
export function applyV2GraphStateWithRbac(
  current: AudioGraphState,
  incoming: AudioGraphState,
  actorId: string,
  role: V2Role,
  locks: readonly LeaseLock[] = [],
  now = Date.now(),
): V2RbacApplyResult {
  const state = cloneState(current);
  const allowedChannels: TrackType[] = [];
  const deniedChannels: TrackType[] = [];
  const channelPermission = v2Can(role, 'edit') || v2Can(role, 'routing');
  const adminOverride = role === 'admin';

  for (const track of ALL_TRACKS) {
    const lockedByOther = isChannelLockedByOther(locks, track, actorId, now);
    if ((lockedByOther && !adminOverride) || !channelPermission) {
      deniedChannels.push(track);
      continue;
    }
    const gain = incoming.channelGainsDb?.[track];
    const pan = incoming.channelPans?.[track];
    if (typeof gain === 'number' && Number.isFinite(gain)) state.channelGainsDb[track] = gain;
    if (typeof pan === 'number' && Number.isFinite(pan)) state.channelPans[track] = pan;
    allowedChannels.push(track);
  }

  const deniedMaster = !v2Can(role, 'master');
  if (!deniedMaster) {
    if (Number.isFinite(incoming.masterVolumeDb)) state.masterVolumeDb = incoming.masterVolumeDb;
    if (typeof incoming.spatialSetupId === 'string') state.spatialSetupId = incoming.spatialSetupId;
  }

  return { state, allowedChannels, deniedChannels, deniedMaster };
}

export interface V2LockSyncResult {
  acquired: string[];
  rejected: string[];
}

/**
 * Synchronisiert V2-Kanal-/Graph-Locks mit einem LockManager.
 * Liefert zurück, welche Objekt-IDs akquiriert bzw. abgelehnt wurden.
 */
export function syncV2Locks(
  locks: { acquire(objectId: string, ownerId: string, leaseMs: number, now?: number): boolean },
  ownerId: string,
  channels: readonly TrackType[],
  leaseMs: number,
  now = Date.now(),
): V2LockSyncResult {
  const acquired: string[] = [];
  const rejected: string[] = [];
  for (const track of channels) {
    const ok = locks.acquire(v2ObjectId('channel', track), ownerId, leaseMs, now);
    if (ok) acquired.push(track);
    else rejected.push(track);
  }
  return { acquired, rejected };
}

/** Liest die aktiven V2-Locks eines LockManagers als LeaseLock-Array. */
export function listV2Locks(manager: { snapshot(now?: number): LeaseLock[] }, now = Date.now()): LeaseLock[] {
  return manager.snapshot(now).filter((l) => l.objectId.startsWith('v2:'));
}
