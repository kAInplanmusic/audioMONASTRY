/**
 * dropMONK – Audio Adapter (Interface-Boundary)
 * ============================================
 * Die Drop-Bridges dürfen keine Plattform-/Engine-APIs direkt kennen.
 * Die App-Schicht (src/utils/dropAudioBridge.ts) registriert hier einen
 * Adapter, der auf die audioEngine zeigt. Ohne Adapter arbeiten die Bridges
 * gegen einen internen In-Memory-State (Tests, SSR, Plugin OFF).
 */

export interface DropMixerChannelSnapshot {
  id: string;
  label: string;
  level: number; // 0..1
  pan: number; // -1..1
  muted: boolean;
  soloed: boolean;
}

export interface DropAudioAdapter {
  /** Aktueller Mixer-Zustand (Kanäle inkl. Level/Pan/Mute). */
  getChannels(): DropMixerChannelSnapshot[];
  /** Kanal-Fader setzen (0..1). */
  setChannelLevel(channelId: string, level: number): void;
  /** Kanal-Pan setzen (-1..1). */
  setChannelPan(channelId: string, pan: number): void;
  /** Kanal stummschalten. */
  setChannelMute(channelId: string, muted: boolean): void;
  /**
   * Plugin-Parameter schreiben. `value` ist bereits auf den Spec-Bereich
   * skaliert (nicht normalisiert).
   */
  setPluginParameter(pluginId: string, parameterId: string, value: number): void;
  /** Aktives Tempo (BPM). */
  getBpm(): number;
  /** IDs der aktuell aktiven Plugins (OFF-Plugins sind nicht enthalten). */
  getActivePluginIds(): string[];
}

let currentAdapter: DropAudioAdapter | null = null;

/** Adapter registrieren (App-Schicht). */
export function setDropAudioAdapter(adapter: DropAudioAdapter | null): void {
  currentAdapter = adapter;
}

/** Aktuellen Adapter lesen (null = Fallback-Modus). */
export function getDropAudioAdapter(): DropAudioAdapter | null {
  return currentAdapter;
}
