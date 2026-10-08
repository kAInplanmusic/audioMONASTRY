/**
 * dropMONK – Audio Adapter (Interface-Boundary)
 * ============================================
 * Die Drop-Bridges dürfen keine Plattform-/Engine-APIs direkt kennen.
 * Die App-Schicht (src/utils/dropAudioBridge.ts) registriert hier einen
 * Adapter, der auf die audioEngine zeigt. Ohne Adapter arbeiten die Bridges
 * gegen einen internen In-Memory-State (Tests, SSR, Plugin OFF).
 */

import type { SpectrumFrame } from './spectrum';

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
  /**
   * Echter FFT-Frame des Master-Ausgangs (optional, SSOT DSP-P2-003).
   *
   * Liefert `null`, wenn kein AudioContext/Analyser verfügbar ist (Headless,
   * Tests, gestoppter V2-Sink). Fehlt die Methode ganz, arbeiten die Bridges
   * unverändert über die Kanal-Pegel.
   */
  readSpectrumFrame?(): SpectrumFrame | null;

  // --- Einspiel-Weg (PREP-6): Drop hörbar auf einen Mixer-Kanal bringen -------
  // Ohne diese Methoden konnte dropMONK einen Drop analysieren und ankuendigen,
  // aber NICHT auf einen Kanal spielen - der Pfad war halb gebaut. Fehlen sie
  // (Tests/SSR/kein Audio), bleibt der Einspiel-Weg no-op statt zu werfen.
  /**
   * Sample auf den Kanal laden. `url` = null entlaedt den Kanal.
   * Liefert `false`, wenn der Kanal ungueltig ist.
   */
  loadTrackSample?(channelId: string, url: string | null): Promise<boolean>;
  /** Kanal-Event feuern (One-Shot). `false` = ungueltiger Kanal. */
  triggerEvent?(channelId: string, velocity: number): boolean;
  /** Kanal auf MAIN einblenden. `false` = ungueltiger Kanal. */
  fadeChannelToMain?(channelId: string, rampSec: number, targetDb: number): boolean;
  /** Callback an der naechsten vollen Bar ausloesen. */
  scheduleAtNextBar?(cb: () => void): void;
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
