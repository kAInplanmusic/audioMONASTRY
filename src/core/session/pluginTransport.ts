/**
 * ▶/■ je Plugin (eingeklappter Streifen) – über die Session, nicht lokal
 * =====================================================================
 * Der Halter eines klingenden Plugins schaltet es auf Main an (▶) oder stumm
 * (■). Der Stand liegt im Plugin-Stand der Session (Bereich `transport`), damit
 * ihn das Gerät mit dem Main-Ton (Mixer-Halter) umsetzt: ■ = Kanal stumm,
 * ▶ = Kanal wieder offen und einmal anspielen. Standard: spielend.
 */
import { flushPluginSettings, readPluginSettings, writePluginSettings } from '../../utils/pluginSettings';

export interface PluginTransport {
  playing: boolean;
  /** Zeitstempel der letzten ▶-Betätigung (für „einmal anspielen"). */
  at: number;
}

const SECTION = 'transport';

export function readPluginTransport(pluginId: string): PluginTransport {
  const t = readPluginSettings<Partial<PluginTransport>>(pluginId, { section: SECTION });
  return {
    playing: typeof t?.playing === 'boolean' ? t.playing : true,
    at: typeof t?.at === 'number' && Number.isFinite(t.at) ? t.at : 0,
  };
}

/** Nur der Halter schreibt (der Speicher verwirft fremde Schreibversuche). */
export function setPluginTransport(pluginId: string, playing: boolean): void {
  writePluginSettings(pluginId, { playing, at: Date.now() }, { section: SECTION });
  flushPluginSettings(pluginId);
}
