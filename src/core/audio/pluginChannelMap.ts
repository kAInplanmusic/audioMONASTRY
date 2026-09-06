import type { TrackType } from '../../types';

/**
 * P0-2: Kanal-Zuordnung der Audio-einspeisenden Plugins (PluginAudioRouter-Kern).
 * UI-only-Plugins liefern ein leeres Array (kein eigener Audio-Graph).
 *
 * Bewusst als eigenes, Tone-freies Modul gehalten, damit Routing-Tests ohne
 * AudioContext/Tone-Mock auskommen und die Matrix nicht an die AudioEngine
 * gekoppelt ist.
 */
export function pluginAudioChannels(pluginId: string): TrackType[] {
  const map: Record<string, TrackType[]> = {
    masterplayer: [],
    ai: [],
    controller: [],
    library: [],
    mastering: [],
    stem: [],
    recording: [],
    performance: [],
    spatial: ['channel7'],
    mixer: ['channel1'],
    mcp: ['channel5'],
    drum: ['channel2'],
    sampler: ['channel5'],
    synthesizer: ['channel4'],
    instrument: ['channel4'],
    voice: ['channel8'],
    sound: ['channel9'],
    drop: ['channel10'],
    effect: ['channel6'],
    dsp: ['channel6'],
    eq: ['channel6'],
  };
  return map[pluginId] ?? [];
}
