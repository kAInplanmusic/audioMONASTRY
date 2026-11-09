/**
 * spatialMONK Scene V2 — pure, versioned control state (SP-P1-01).
 *
 * Intentionally not connected to the active AudioGraph. Coordinates are
 * metres, +X right, +Y front, listener-relative azimuth 0° = front.
 * Rendering, hardware routing and permissions are separate responsibilities.
 */
export const SPATIAL_SCENE_VERSION = 2 as const;

export interface SpatialVec2 { x: number; y: number }
export interface SpatialRoomV2 { widthM: number; depthM: number }
export type SpatialObjectKindV2 = 'mono' | 'stereo-pair' | 'bed';
export type SpatialAlgorithmV2 = 'vbap2d' | 'dbap2d' | 'hoa2d';

export interface SpatialObjectV2 {
  id: string;
  pluginId: string;
  channelId: string;
  kind: SpatialObjectKindV2;
  positionM: SpatialVec2;
  gainDb: number;
  spread: number; // [0,1]
  width: number; // [0,2]
  enabled: boolean;
  muted: boolean;
  revision: number;
}

export interface SpatialSpeakerV2 {
  id: string;
  role: 'satellite' | 'subwoofer';
  positionM: SpatialVec2;
  /** Zero-based hardware channel; null means no physical assignment. */
  outputChannel: number | null;
  trimDb: number;
  delayMs: number;
  polarity: 1 | -1;
}

export interface SpatialSceneV2 {
  schemaVersion: typeof SPATIAL_SCENE_VERSION;
  revision: number;
  room: SpatialRoomV2;
  listenerM: SpatialVec2;
  objects: SpatialObjectV2[];
  speakers: SpatialSpeakerV2[];
  algorithm: SpatialAlgorithmV2;
}

export interface SpatialMoveCommandV2 {
  kind: 'object.move';
  opId: string;
  actorId: string;
  baseRevision: number;
  objectId: string;
  positionM: SpatialVec2;
}

export type SpatialApplyResult =
  | { ok: true; scene: SpatialSceneV2 }
  | { ok: false; reason: 'INVALID' | 'STALE_REVISION' | 'NOT_FOUND'; scene: SpatialSceneV2 };

const finite = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n);
const safeRevision = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const validPoint = (p: unknown): p is SpatialVec2 => {
  if (!p || typeof p !== 'object') return false;
  const v = p as Partial<SpatialVec2>;
  return finite(v.x) && finite(v.y);
};

export function validateSpatialSceneV2(scene: SpatialSceneV2): string[] {
  const errors: string[] = [];
  if (!scene || scene.schemaVersion !== 2) return ['Unsupported scene version'];
  if (!safeRevision(scene.revision)) errors.push('Invalid scene revision');
  if (!scene.room || !finite(scene.room.widthM) || !finite(scene.room.depthM) ||
      scene.room.widthM <= 0 || scene.room.depthM <= 0) errors.push('Invalid room dimensions');
  if (!validPoint(scene.listenerM)) errors.push('Invalid listener position');
  if (!Array.isArray(scene.objects)) errors.push('Invalid objects array');
  if (!Array.isArray(scene.speakers)) errors.push('Invalid speakers array');
  if (!(['vbap2d', 'dbap2d', 'hoa2d'] as const).includes(scene.algorithm)) {
    errors.push('Unknown spatial algorithm');
  }

  const objectIds = new Set<string>();
  for (const obj of Array.isArray(scene.objects) ? scene.objects : []) {
    if (!obj || typeof obj.id !== 'string' || !obj.id) {
      errors.push('Invalid object id');
      continue;
    }
    if (objectIds.has(obj.id)) errors.push('Duplicate object id: ' + obj.id);
    objectIds.add(obj.id);
    if (typeof obj.pluginId !== 'string' || typeof obj.channelId !== 'string') {
      errors.push('Invalid object routing: ' + obj.id);
    }
    if (!(['mono', 'stereo-pair', 'bed'] as const).includes(obj.kind)) {
      errors.push('Invalid object kind: ' + obj.id);
    }
    if (!validPoint(obj.positionM) || !finite(obj.gainDb) ||
        !finite(obj.spread) || obj.spread < 0 || obj.spread > 1 ||
        !finite(obj.width) || obj.width < 0 || obj.width > 2 ||
        !safeRevision(obj.revision)) errors.push('Invalid object values: ' + obj.id);
  }

  const speakerIds = new Set<string>();
  const channels = new Set<number>();
  for (const sp of Array.isArray(scene.speakers) ? scene.speakers : []) {
    if (!sp || typeof sp.id !== 'string' || !sp.id) {
      errors.push('Invalid speaker id');
      continue;
    }
    if (speakerIds.has(sp.id)) errors.push('Duplicate speaker id: ' + sp.id);
    speakerIds.add(sp.id);
    if (sp.role !== 'satellite' && sp.role !== 'subwoofer') {
      errors.push('Invalid speaker role: ' + sp.id);
    }
    if (!validPoint(sp.positionM) || !finite(sp.trimDb) || !finite(sp.delayMs) ||
        sp.delayMs < 0 || (sp.polarity !== 1 && sp.polarity !== -1)) {
      errors.push('Invalid speaker values: ' + sp.id);
    }
    if (sp.outputChannel !== null) {
      if (!Number.isSafeInteger(sp.outputChannel) || sp.outputChannel < 0) {
        errors.push('Invalid physical output channel: ' + sp.id);
      } else if (channels.has(sp.outputChannel)) {
        errors.push('Duplicate physical output channel: ' + sp.outputChannel);
      } else channels.add(sp.outputChannel);
    }
  }
  return errors;
}

/** Deterministic positions at equal arc-length along a rectangular perimeter. */
export function createPerimeterSpeakers(
  room: SpatialRoomV2, count = 16,
): SpatialSpeakerV2[] {
  if (!Number.isSafeInteger(count) || count < 2 || count > 24 ||
      !finite(room.widthM) || !finite(room.depthM) ||
      room.widthM <= 0 || room.depthM <= 0) throw new Error('Invalid perimeter setup');
  const w = room.widthM, d = room.depthM;
  const perimeter = 2 * (w + d);
  return Array.from({ length: count }, (_, i) => {
    const at = perimeter * i / count;
    let x: number, y: number;
    if (at < w) { x = -w / 2 + at; y = d / 2; }
    else if (at < w + d) { x = w / 2; y = d / 2 - (at - w); }
    else if (at < 2 * w + d) { x = w / 2 - (at - w - d); y = -d / 2; }
    else { x = -w / 2; y = -d / 2 + (at - 2 * w - d); }
    return {
      id: 'sat-' + String(i + 1).padStart(2, '0'),
      role: 'satellite' as const,
      positionM: { x, y },
      outputChannel: null,
      trimDb: 0,
      delayMs: 0,
      polarity: 1 as const,
    };
  });
}

export function createSpatialSceneV2(room: SpatialRoomV2 = { widthM: 4, depthM: 4 }): SpatialSceneV2 {
  return {
    schemaVersion: 2, revision: 0,
    room: { ...room }, listenerM: { x: 0, y: 0 },
    objects: [], speakers: createPerimeterSpeakers(room, 16),
    algorithm: 'vbap2d',
  };
}

/**
 * Pure optimistic revision check. Permissions and idempotency (opId) belong
 * to the authenticated command service, not this model function.
 */
export function applySpatialMoveV2(
  scene: SpatialSceneV2, command: SpatialMoveCommandV2,
): SpatialApplyResult {
  if (!command || command.kind !== 'object.move' ||
      !command.opId || !command.actorId || !validPoint(command.positionM) ||
      !safeRevision(command.baseRevision)) return { ok: false, reason: 'INVALID', scene };
  if (command.baseRevision !== scene.revision) {
    return { ok: false, reason: 'STALE_REVISION', scene };
  }
  const index = scene.objects.findIndex((o) => o.id === command.objectId);
  if (index === -1) return { ok: false, reason: 'NOT_FOUND', scene };
  const original = scene.objects[index];
  const objects = [...scene.objects];
  objects[index] = {
    ...original,
    positionM: { ...command.positionM },
    revision: original.revision + 1,
  };
  return { ok: true, scene: { ...scene, revision: scene.revision + 1, objects } };
}

/** Read-only bridge for existing spatialMONK-v1 presets (not persisted automatically). */
export function projectLegacySourcesV2(
  sources: readonly { id: number; name: string; az: number; dist: number; gain: number; muted: boolean }[],
  room: SpatialRoomV2 = { widthM: 4, depthM: 4 },
): SpatialSceneV2 {
  const scene = createSpatialSceneV2(room);
  scene.objects = sources.map((s) => {
    const az = finite(s.az) ? s.az * Math.PI / 180 : 0;
    const distance = finite(s.dist) ? Math.max(0, s.dist) : 0;
    return {
      id: 'legacy-' + s.id,
      pluginId: 'spatial',
      channelId: 'legacy-' + s.id,
      kind: 'mono',
      positionM: {
        x: Math.max(-room.widthM / 2, Math.min(room.widthM / 2, Math.sin(az) * distance)),
        y: Math.max(-room.depthM / 2, Math.min(room.depthM / 2, Math.cos(az) * distance)),
      },
      gainDb: 20 * Math.log10(Math.max(1e-6, finite(s.gain) ? Math.max(0, s.gain) : 1)),
      spread: 0, width: 1, enabled: true, muted: s.muted, revision: 0,
    };
  });
  return scene;
}
