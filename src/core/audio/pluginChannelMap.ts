import { ALL_TRACKS, type TrackType } from '../../types';
import { CONTRACT_BY_ID } from '../../plugins/pluginContract';

/**
 * P0-2: Kanal-Zuordnung der Audio-einspeisenden Plugins (PluginAudioRouter-Kern).
 * UI-only-Plugins liefern ein leeres Array (kein eigener Audio-Graph).
 *
 * Bewusst als eigenes, Tone-freies Modul gehalten, damit Routing-Tests ohne
 * AudioContext/Tone-Mock auskommen und die Matrix nicht an die AudioEngine
 * gekoppelt ist.
 *
 * B1 (2026-10-07): Die Zuordnung der 16 kanonischen Plugins wird NICHT mehr
 * hier gepflegt, sondern aus `plugins/pluginContract.ts` gelesen - der einen
 * Quelle fuer Rolle, Kanal und Format. Eine zweite Liste an dieser Stelle war
 * die Art von Doppelpflege, die still auseinanderlaeuft.
 */

/** Kanal eines kanonischen Plugins, direkt aus dem Vertrag. */
function channelTrackOf(pluginId: string): TrackType | null {
  const channel = CONTRACT_BY_ID[pluginId]?.channel ?? null;
  return channel === null ? null : (`channel${channel}` as TrackType);
}

/**
 * Migrations-Aliase: alte IDs zeigen weiter auf ihr Ziel, damit ungestellte
 * Referenzen nicht still ins Leere laufen. Live in Gebrauch - `audioEngine.ts`
 * fragt z.B. `pluginAudioChannels('drum')` ab (Zeile 1305).
 */
const LEGACY_ALIASES: Record<string, string> = {
  sampler: 'syntisampler',
  synthesizer: 'syntisampler',
  drum: 'drumsampler',
  instrument: 'instru',
};

/**
 * System-Module und UI-only-Plugins OHNE eigenen Audio-Graph. Sie liefern ein
 * leeres Array. Bewusst als Liste statt als Vertrags-Eigenschaft: der Vertrag
 * beschreibt die 16 Plugins, diese Eintraege sind KEINE Plugin-Slots mehr
 * (masterplayer/ai/perfor sind System-Module, controller/performance sind in
 * die Settings gewandert).
 */
const NON_AUDIO_IDS = new Set([
  'masterplayer', 'ai', 'perfor',
  'library', 'mastering', 'recording', // Alt-Namen der konsolidierten Plugins
  'mcp', 'controller', 'performance',
]);

export function pluginAudioChannels(pluginId: string): TrackType[] {
  const canonical = LEGACY_ALIASES[pluginId] ?? pluginId;
  if (NON_AUDIO_IDS.has(canonical)) return [];
  const track = channelTrackOf(canonical);
  return track ? [track] : [];
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
