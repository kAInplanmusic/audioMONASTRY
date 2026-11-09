/**
 * spatialMONK output capability guard (SP-P1-04).
 * This is a decision-only utility: it never connects browser outputs.
 * Output counts are assertions from a verified device/bridge adapter.
 */
export type SpatialOutputMode = 'stereo-main' | 'binaural-cue' | 'spatial-main-exclusive';
export interface SpatialOutputCapabilities {
  deviceId: string;
  verifiedDiscreteOutputs: number;
  /** Explicitly excludes unverified browser-created virtual channels. */
  isVerified: boolean;
}
export interface SpatialOutputDecision {
  mode: SpatialOutputMode;
  channels: number;
  reason: string | null;
}

export function resolveSpatialOutput(
  requested: SpatialOutputMode,
  requiredChannels: number,
  caps: SpatialOutputCapabilities | null,
): SpatialOutputDecision {
  if (requested !== 'spatial-main-exclusive') {
    return { mode: requested === 'binaural-cue' ? 'binaural-cue' : 'stereo-main', channels: 2, reason: null };
  }
  if (!Number.isSafeInteger(requiredChannels) || requiredChannels < 2 || requiredChannels > 26) {
    return { mode: 'stereo-main', channels: 2, reason: 'Invalid spatial channel count' };
  }
  if (!caps?.isVerified || !Number.isSafeInteger(caps.verifiedDiscreteOutputs) ||
      caps.verifiedDiscreteOutputs < requiredChannels) {
    return { mode: 'stereo-main', channels: 2, reason: 'Physical output capability not verified' };
  }
  return { mode: 'spatial-main-exclusive', channels: requiredChannels, reason: null };
}
