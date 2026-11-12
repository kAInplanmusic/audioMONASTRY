/**
 * spatialMONK V2 physical output planning (SP-P1-04 / SP-P2-04).
 *
 * Explicitly distinct from WebAudio ChannelMerger and virtual speaker layouts.
 * No connections or device claims are performed by this pure planning module.
 */
import type { SpatialSceneV2 } from './model';
import { validateSpatialSceneV2 } from './model';
import type { SpatialOutputCapabilities } from './outputPolicy';
import { resolveSpatialOutput } from './outputPolicy';

export interface SpatialPhysicalRoute {
  speakerId: string;
  speakerIndex: number;
  deviceChannel: number;
  role: 'satellite' | 'subwoofer';
}
export type SpatialPhysicalPlan =
  | { ok: true; routes: SpatialPhysicalRoute[]; deviceChannels: number }
  | { ok: false; reason: string; routes: [] };

export function planSpatialPhysicalOutputs(
  scene: SpatialSceneV2,
  capabilities: SpatialOutputCapabilities | null,
): SpatialPhysicalPlan {
  const errors = validateSpatialSceneV2(scene);
  if (errors.length) return { ok: false, reason: 'Invalid scene: ' + errors.join('; '), routes: [] };
  const resolved = resolveSpatialOutput('spatial-main-exclusive', scene.speakers.length, capabilities);
  if (resolved.mode !== 'spatial-main-exclusive' || !capabilities) {
    return { ok: false, reason: resolved.reason ?? 'Spatial output not available', routes: [] };
  }

  const routes: SpatialPhysicalRoute[] = [];
  for (let i = 0; i < scene.speakers.length; i++) {
    const speaker = scene.speakers[i];
    if (speaker.outputChannel === null) {
      return { ok: false, reason: 'Unassigned speaker: ' + speaker.id, routes: [] };
    }
    if (speaker.outputChannel >= capabilities.verifiedDiscreteOutputs) {
      return { ok: false, reason: 'Device channel out of range: ' + speaker.id, routes: [] };
    }
    routes.push({
      speakerId: speaker.id, speakerIndex: i,
      deviceChannel: speaker.outputChannel, role: speaker.role,
    });
  }
  return { ok: true, routes, deviceChannels: capabilities.verifiedDiscreteOutputs };
}

/**
 * OFFLINE reference for channel identity, polarity, gain and integer delay.
 * No interpolation, no EQ, no bass crossover, no limiter. It is not the
 * production DSP and does not imply a real device is connected.
 *
 * The returned buffers include delay tails so signals are never truncated.
 */
export function applySpatialPhysicalCalibrationOffline(
  scene: SpatialSceneV2,
  speakerChannels: readonly Float32Array[],
  sampleRate: number,
  plan: Extract<SpatialPhysicalPlan, { ok: true }>,
): Float32Array[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Invalid sample rate');
  if (speakerChannels.length !== scene.speakers.length) {
    throw new Error('Speaker channel count mismatch');
  }
  const frames = speakerChannels[0]?.length ?? 0;
  if (!speakerChannels.every((channel) => channel.length === frames)) {
    throw new Error('Unequal speaker block lengths');
  }
  const delays = plan.routes.map(({ speakerIndex }) =>
    Math.round(scene.speakers[speakerIndex].delayMs * sampleRate / 1000));
  if (delays.some((d) => !Number.isSafeInteger(d) || d < 0 || d > sampleRate * 2)) {
    throw new Error('Invalid speaker calibration delay');
  }
  const maxDelay = Math.max(0, ...delays);
  const outputs = Array.from({ length: plan.deviceChannels }, () => new Float32Array(frames + maxDelay));

  plan.routes.forEach((route, i) => {
    const speaker = scene.speakers[route.speakerIndex];
    if (speaker.id !== route.speakerId || speaker.outputChannel !== route.deviceChannel) {
      throw new Error('Stale physical routing plan');
    }
    const gain = Math.pow(10, Math.max(-120, Math.min(12, speaker.trimDb)) / 20) * speaker.polarity;
    const from = speakerChannels[route.speakerIndex];
    const to = outputs[route.deviceChannel];
    const delay = delays[i];
    for (let n = 0; n < frames; n++) {
      const sample = from[n];
      to[n + delay] += (Number.isFinite(sample) ? sample : 0) * gain;
    }
  });
  return outputs;
}
