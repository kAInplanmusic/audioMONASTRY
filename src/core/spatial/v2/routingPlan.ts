/**
 * spatialMONK — independent two-axis Spatial-Main routing contract.
 * Pure policy/partition; does NOT alter the live mixer or connect AudioNodes.
 *
 * Shared stereo remains the source of truth for DJ, recording, livestream,
 * collaboration and all non-Spatial-Main outputs.
 */
import {
  resolveSpatialOutput,
  type SpatialOutputCapabilities,
  type SpatialOutputDecision,
} from './outputPolicy';

export type StereoAudienceV2 = 'dj' | 'monitor' | 'stream' | 'recorder' | 'collaborator';

export interface SpatialInjectionV2 {
  id: string;
  format: 'mono' | 'stereo';
  destination: 'spatial-only';
}

export interface SpatialRoutingRequestV2 {
  availableMixerChannels: readonly string[];
  selectedMixerChannels: readonly string[];
  injections?: readonly SpatialInjectionV2[];
  enableSpatialMain: boolean;
  requiredMainOutputChannels: number;
  mainOutputCapabilities: SpatialOutputCapabilities | null;
}

export interface SpatialRoutingPlanV2 {
  readonly canonicalStereoMaster: 'mixerMONK';
  readonly mixerStereoUnmodified: true;
  readonly stereoAudiences: readonly StereoAudienceV2[];
  readonly main: SpatialOutputDecision;
  /** Selected dry channels are POSITIONED as objects in Spatial-Main. */
  readonly selectedDrySpatialObjects: readonly string[];
  /** Remaining dry channels + the stereo FX return build Spatial-Main bed. */
  readonly stereoBedChannels: readonly string[];
  readonly includeStereoFxReturnsInBed: true;
  readonly spatialOnlyInjections: readonly SpatialInjectionV2[];
  readonly sourceTapSemantics: 'post-fader-copy';
  readonly spatialMainDrySemantics: 'replace-selected-dry';
}

const STEREO_AUDIENCES: readonly StereoAudienceV2[] = Object.freeze([
  'dj', 'monitor', 'stream', 'recorder', 'collaborator',
]);

function uniqueRequired(ids: readonly string[], subject: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !id) throw new Error(subject + ': invalid id');
    if (seen.has(id)) throw new Error(subject + ': duplicate id ' + id);
    seen.add(id);
  }
}

export function createSpatialRoutingPlanV2(req: SpatialRoutingRequestV2): SpatialRoutingPlanV2 {
  uniqueRequired(req.availableMixerChannels, 'mixer');
  uniqueRequired(req.selectedMixerChannels, 'selection');
  const available = new Set(req.availableMixerChannels);
  for (const id of req.selectedMixerChannels) {
    if (!available.has(id)) throw new Error('Inactive selected mixer channel: ' + id);
  }
  const injections = req.injections ?? [];
  uniqueRequired(injections.map((i) => i.id), 'injection');
  for (const i of injections) {
    if (i.destination !== 'spatial-only' || (i.format !== 'mono' && i.format !== 'stereo')) {
      throw new Error('Invalid spatial injection: ' + i.id);
    }
    if (available.has(i.id)) throw new Error('Injection conflicts with mixer channel: ' + i.id);
  }
  const selected = new Set(req.selectedMixerChannels);
  const main = resolveSpatialOutput(
    req.enableSpatialMain ? 'spatial-main-exclusive' : 'stereo-main',
    req.requiredMainOutputChannels,
    req.mainOutputCapabilities,
  );
  return {
    canonicalStereoMaster: 'mixerMONK',
    mixerStereoUnmodified: true,
    stereoAudiences: STEREO_AUDIENCES,
    main,
    selectedDrySpatialObjects: req.availableMixerChannels.filter((id) => selected.has(id)),
    stereoBedChannels: req.availableMixerChannels.filter((id) => !selected.has(id)),
    includeStereoFxReturnsInBed: true,
    spatialOnlyInjections: injections.map((i) => ({ ...i })),
    sourceTapSemantics: 'post-fader-copy',
    spatialMainDrySemantics: 'replace-selected-dry',
  };
}

export function verifySpatialRoutingPartitionV2(
  plan: SpatialRoutingPlanV2,
  activeIds: readonly string[],
): boolean {
  const combined = [...plan.selectedDrySpatialObjects, ...plan.stereoBedChannels];
  if (combined.length !== activeIds.length) return false;
  const unique = new Set(combined);
  return unique.size === activeIds.length && activeIds.every((id) => unique.has(id));
}
