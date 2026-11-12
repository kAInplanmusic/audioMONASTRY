/**
 * spatialMONK V2 isolated OFFLINE object bus (SP-P1-02).
 *
 * Unlike the legacy stereo-master upmix, each source has its own audio block
 * and direction. The output buffers correspond to scene.speakers order, NOT
 * physical device channels. Subwoofer outputs are silent until the separately
 * verified bass-management engine is available.
 *
 * This intentionally allocates and validates: NEVER call from AudioWorklet
 * process(). A future RT engine will preallocate and smooth per-source gains.
 */
import type { SpatialSceneV2 } from './model';
import { validateSpatialSceneV2 } from './model';
import { calculateVbap2dGains } from './vbap2d';

export interface SpatialMonoObjectBlock {
  objectId: string;
  samples: Float32Array;
}
export interface SpatialOfflineBusResult {
  speakerIds: string[];
  channels: Float32Array[];
}

/**
 * Deterministic object-based render for test fixtures, export prototypes
 * and signal-topology regression. No speaker equalization, PDC, or limiter.
 */
export function renderSpatialObjectsOffline(
  scene: SpatialSceneV2,
  blocks: readonly SpatialMonoObjectBlock[],
  frames: number,
): SpatialOfflineBusResult {
  if (!Number.isSafeInteger(frames) || frames < 0) throw new Error('Invalid block frame count');
  const errors = validateSpatialSceneV2(scene);
  if (errors.length) throw new Error('Invalid scene: ' + errors.join('; '));
  if (scene.algorithm !== 'vbap2d') throw new Error('Only VBAP2D is implemented in the offline reference');
  const speakerIds = scene.speakers.map((s) => s.id);
  const channels = scene.speakers.map(() => new Float32Array(frames));
  const objectMap = new Map(scene.objects.map((o) => [o.id, o]));
  const used = new Set<string>();

  for (const block of blocks) {
    if (used.has(block.objectId)) throw new Error('Duplicate audio block: ' + block.objectId);
    used.add(block.objectId);
    const object = objectMap.get(block.objectId);
    if (!object) throw new Error('Unregistered object: ' + block.objectId);
    if (!(block.samples instanceof Float32Array) || block.samples.length !== frames) {
      throw new Error('Object block length mismatch: ' + block.objectId);
    }
    if (!object.enabled || object.muted) continue;
    if (object.kind !== 'mono') {
      throw new Error('Stereo/bed requires an explicit decomposition policy: ' + object.id);
    }
    const linearGain = Math.pow(10, Math.max(-120, Math.min(24, object.gainDb)) / 20);
    const weights = calculateVbap2dGains(object.positionM, scene.listenerM, scene.speakers);
    for (let channel = 0; channel < channels.length; channel++) {
      if (scene.speakers[channel].role === 'subwoofer') continue;
      const gain = weights[channel].gain * linearGain;
      if (gain === 0) continue;
      const target = channels[channel];
      for (let frame = 0; frame < frames; frame++) {
        const sample = block.samples[frame];
        target[frame] += (Number.isFinite(sample) ? sample : 0) * gain;
      }
    }
  }
  return { speakerIds, channels };
}
