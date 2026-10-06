import { ALL_TRACKS, type TrackType } from '../../types';

/**
 * P0-2: Kanal-Zuordnung der Audio-einspeisenden Plugins (PluginAudioRouter-Kern).
 * UI-only-Plugins liefern ein leeres Array (kein eigener Audio-Graph).
 *
 * Bewusst als eigenes, Tone-freies Modul gehalten, damit Routing-Tests ohne
 * AudioContext/Tone-Mock auskommen und die Matrix nicht an die AudioEngine
 * gekoppelt ist.
 */
export function pluginAudioChannels(pluginId: string): TrackType[] {
  // ARCH-PLUGIN-001: 16-MONK-Zielkanäle. Alte IDs bleiben als dokumentierte
  // Migrations-Aliase erhalten, bis alle Referenzen umgestellt sind.
  const map: Record<string, TrackType[]> = {
    masterplayer: [],
    ai: [],
    perfor: [],
    biblio: [],
    library: [],
    master: [],
    mastering: [],
    stem: ['channel8'],
    record: [],
    recording: [],
    spatial: [],
    mixer: [],
    // syntisamplerMONK: EIN Kanal (4) im 8-Kanal-Modell (UI2-P0-001).
    // Die Alt-Aliase zeigen auf dasselbe Ziel, damit ungestellte Referenzen
    // nicht still ins Leere laufen.
    syntisampler: ['channel4'],
    mcp: [],
    sampler: ['channel4'],
    synthesizer: ['channel4'],
    drumsampler: ['channel3'],
    drum: ['channel3'],
    instru: ['channel5'],
    instrument: ['channel5'],
    voice: ['channel6'],
    sound: ['channel7'],
    drop: ['channel1'],
    song: ['channel2'],
    effect: [],
    dsp: [],
    eq: [],
    // controller/perf sind KEINE Plugin-Slots mehr (Settings/perforMONK).
    controller: [],
    performance: [],
  };
  return map[pluginId] ?? [];
}

/**
 * Phase 4 / V2: Liefert den Cue-Solo-Kanal eines Plugins (erster Audio-Kanal).
 * Wird verwendet, um `planMonitorRouting({ source: 'PLUGIN' | 'MIX', track })`
 * direkt aus der Plugin-ID abzuleiten.
 */
export function pluginMonitorSoloTrack(pluginId: string): TrackType | null {
  return pluginAudioChannels(pluginId)[0] ?? null;
}

/**
 * Phase 4 / V2: Baut eine vollständige Cue-Matrix für ein Plugin-Solo.
 * Alle Kanäle des Plugins bleiben hörbar (bei Multi-Kanal-Plugins), alle
 * anderen Kanäle werden im Cue stumm geschaltet. `baseMix` wird nur für die
 * Plugin-Kanäle als Ausgangspegel verwendet (0 → 1, damit Solo nie verstummt).
 */
export function pluginSoloCueTracks(
  pluginId: string,
  baseMix: Partial<Record<TrackType, number>> = {},
): Record<TrackType, number> {
  const channels = new Set(pluginAudioChannels(pluginId));
  const cueTracks = {} as Record<TrackType, number>;
  for (const track of ALL_TRACKS) {
    if (!channels.has(track)) {
      cueTracks[track] = 0;
      continue;
    }
    const base = baseMix[track];
    const value = typeof base === 'number' && Number.isFinite(base)
      ? Math.max(0, Math.min(2, base))
      : 1;
    cueTracks[track] = value > 0 ? value : 1;
  }
  return cueTracks;
}
