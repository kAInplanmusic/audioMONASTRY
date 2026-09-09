import type {
  CanonicalPluginId,
  PluginInterface,
} from '../plugin_interface';

import { MixerPluginAdapter } from './MixerPluginAdapter';
import { DropPluginAdapter } from './DropPluginAdapter';
import { SongPluginAdapter } from './SongPluginAdapter';
import { EffectPluginAdapter } from './EffectPluginAdapter';
import { SyntiSamplerPluginAdapter } from './SyntiSamplerPluginAdapter';
import { DrumSamplerPluginAdapter } from './DrumSamplerPluginAdapter';
import { InstruPluginAdapter } from './InstruPluginAdapter';
import { BiblioPluginAdapter } from './BiblioPluginAdapter';
import { VoicePluginAdapter } from './VoicePluginAdapter';
import { SoundPluginAdapter } from './SoundPluginAdapter';
import { StemPluginAdapter } from './StemPluginAdapter';
import { SpatialPluginAdapter } from './SpatialPluginAdapter';
import { EqPluginAdapter } from './EqPluginAdapter';
import { DspPluginAdapter } from './DspPluginAdapter';
import { MasterPluginAdapter } from './MasterPluginAdapter';
import { RecordPluginAdapter } from './RecordPluginAdapter';

export const CANONICAL_PLUGIN_IDS: readonly CanonicalPluginId[] = [
  'mixer',
  'drop',
  'song',
  'effect',
  'syntisampler',
  'drumsampler',
  'instru',
  'biblio',
  'voice',
  'sound',
  'stem',
  'spatial',
  'eq',
  'dsp',
  'master',
  'record',
];

export function createPluginAdapters(): Record<
  CanonicalPluginId,
  PluginInterface
> {
  const adapters: Record<CanonicalPluginId, PluginInterface> = {
    mixer: new MixerPluginAdapter(),
    drop: new DropPluginAdapter(),
    song: new SongPluginAdapter(),
    effect: new EffectPluginAdapter(),
    syntisampler: new SyntiSamplerPluginAdapter(),
    drumsampler: new DrumSamplerPluginAdapter(),
    instru: new InstruPluginAdapter(),
    biblio: new BiblioPluginAdapter(),
    voice: new VoicePluginAdapter(),
    sound: new SoundPluginAdapter(),
    stem: new StemPluginAdapter(),
    spatial: new SpatialPluginAdapter(),
    eq: new EqPluginAdapter(),
    dsp: new DspPluginAdapter(),
    master: new MasterPluginAdapter(),
    record: new RecordPluginAdapter(),
  };

  if (Object.keys(adapters).length !== CANONICAL_PLUGIN_IDS.length) {
    throw new Error('Canonical plugin adapter count mismatch');
  }

  return adapters;
}
