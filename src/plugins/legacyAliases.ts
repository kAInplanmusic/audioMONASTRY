import type { CanonicalPluginId } from './plugin_interface';

/**
 * Explizite Legacy-→Kanonisch-Zuordnung.
 *
 * Systemmodule (`masterplayer`, `ai`, `performance`, `perfor`, `controller`)
 * sind hier BEWUSST nicht enthalten und werden NICHT als kanonische
 * AudioMONASTRY-Plugins gezählt.
 */
export const LEGACY_PLUGIN_ALIASES: Readonly<
  Record<string, CanonicalPluginId>
> = {
  instrument: 'instru',
  sampler: 'syntisampler',
  synthesizer: 'syntisampler',
  mcp: 'syntisampler',
  drum: 'drumsampler',
  library: 'biblio',
  mastering: 'master',
  recording: 'record',
};

const CANONICAL_IDS: ReadonlySet<string> = new Set([
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
]);

export function resolveCanonicalPluginId(
  id: string,
): CanonicalPluginId | null {
  if (id in LEGACY_PLUGIN_ALIASES) {
    return LEGACY_PLUGIN_ALIASES[id];
  }

  return CANONICAL_IDS.has(id) ? (id as CanonicalPluginId) : null;
}
