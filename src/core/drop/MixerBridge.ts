/**
 * dropMONK – Mixer Integration Bridge
 * ==================================
 * Verbindet dropMONK mit den Mixer-Kanälen der audioEngine (via
 * DropAudioAdapter). Ohne registrierten Adapter arbeitet die Bridge gegen
 * einen internen State – so bleiben Tests und der OFF-Zustand deterministisch.
 */

import { getDropAudioAdapter } from './DropAudioAdapter';
import type { DropMixerChannelSnapshot } from './DropAudioAdapter';

/**
 * Mixer Channel State (read from audioEngine)
 */
export type MixerChannelState = DropMixerChannelSnapshot;

const DEFAULT_CHANNELS: MixerChannelState[] = [
  { id: 'channel1', label: 'CH1', level: 0, pan: 0, muted: false, soloed: false },
  { id: 'channel2', label: 'CH2', level: 0, pan: 0, muted: false, soloed: false },
  { id: 'channel3', label: 'CH3', level: 0, pan: 0, muted: false, soloed: false },
  { id: 'channel4', label: 'CH4', level: 0, pan: 0, muted: false, soloed: false },
  { id: 'channel5', label: 'CH5', level: 0, pan: 0, muted: false, soloed: false },
];

const clamp = (v: number, min: number, max: number): number =>
  Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;

/**
 * Mixer Integration Bridge
 * Bridges dropMONK drop engine to mixer channels
 */
export class MixerBridge {
  /** Fallback-State, falls kein Audio-Adapter registriert ist. */
  private fallbackChannels: Map<string, MixerChannelState> = new Map(
    DEFAULT_CHANNELS.map((ch) => [ch.id, { ...ch }])
  );

  /**
   * Aktueller Mixer-State (Adapter oder Fallback)
   */
  getCurrentMixerState(): MixerChannelState[] {
    const adapter = getDropAudioAdapter();
    if (adapter) {
      try {
        return adapter.getChannels().map((ch) => ({ ...ch }));
      } catch {
        /* Adapter-Fehler → Fallback */
      }
    }
    return Array.from(this.fallbackChannels.values()).map((ch) => ({ ...ch }));
  }

  /**
   * Kanal-Fader setzen (0..1)
   */
  setMixerLevel(channelId: string, level: number): boolean {
    if (!Number.isFinite(level) || level < 0 || level > 1) {
      console.error('Invalid mixer level:', level);
      return false;
    }

    const adapter = getDropAudioAdapter();
    if (adapter) {
      adapter.setChannelLevel(channelId, level);
      return true;
    }

    this.updateFallback(channelId, { level });
    return true;
  }

  /**
   * Kanal-Pan setzen (-1..1)
   */
  setMixerPan(channelId: string, pan: number): boolean {
    if (!Number.isFinite(pan) || pan < -1 || pan > 1) {
      console.error('Invalid pan value:', pan);
      return false;
    }

    const adapter = getDropAudioAdapter();
    if (adapter) {
      adapter.setChannelPan(channelId, pan);
      return true;
    }

    this.updateFallback(channelId, { pan });
    return true;
  }

  /**
   * Mute/unmute channel
   */
  setMixerMute(channelId: string, muted: boolean): void {
    const adapter = getDropAudioAdapter();
    if (adapter) {
      adapter.setChannelMute(channelId, muted);
      return;
    }
    this.updateFallback(channelId, { muted });
  }

  /**
   * Crossfade zwischen zwei Kanälen (Equal-Power, DJ-Transition).
   * Läuft nicht im Audio-Thread: die eigentlichen Fader-Rampen erledigt
   * die audioEngine, hier wird nur die Kurve gestuft geschrieben.
   */
  async crossfade(
    fromChannel: string,
    toChannel: string,
    duration: number = 2000,
    steps: number = 50
  ): Promise<void> {
    const safeSteps = Math.max(1, Math.round(steps));
    const stepDuration = Math.max(0, duration) / safeSteps;

    for (let i = 0; i <= safeSteps; i++) {
      const progress = i / safeSteps;
      const { from, to } = MixerBridge.equalPowerGains(progress);

      this.setMixerLevel(fromChannel, from);
      this.setMixerLevel(toChannel, to);

      if (i < safeSteps && stepDuration > 0) {
        await new Promise((resolve) => setTimeout(resolve, stepDuration));
      }
    }

    // Endzustand garantieren
    this.setMixerLevel(fromChannel, 0);
    this.setMixerLevel(toChannel, 1);
  }

  /**
   * Equal-Power-Crossfade-Kurve (Summe der Leistungen bleibt konstant)
   */
  static equalPowerGains(progress: number): { from: number; to: number } {
    const p = clamp(progress, 0, 1);
    return {
      from: Math.cos((p * Math.PI) / 2),
      to: Math.sin((p * Math.PI) / 2),
    };
  }

  /**
   * Energie-Level des Mixes (0..1) für die Kontext-Analyse
   */
  getEnergyLevel(): number {
    const channels = this.getCurrentMixerState();
    const unmutedChannels = channels.filter((ch) => !ch.muted);

    if (unmutedChannels.length === 0) return 0;

    const avgLevel =
      unmutedChannels.reduce((sum, ch) => sum + ch.level, 0) / unmutedChannels.length;
    return Math.min(1, avgLevel * 1.2); // leichter Boost für bessere Erkennung
  }

  /**
   * Aktive Kanäle (nicht gemutet, Level > 0)
   */
  getActiveChannels(): MixerChannelState[] {
    return this.getCurrentMixerState().filter((ch) => !ch.muted && ch.level > 0.01);
  }

  /** Fallback-State aktualisieren (nur ohne Adapter relevant). */
  private updateFallback(channelId: string, patch: Partial<MixerChannelState>): void {
    const existing = this.fallbackChannels.get(channelId) ?? {
      id: channelId,
      label: channelId.toUpperCase(),
      level: 0,
      pan: 0,
      muted: false,
      soloed: false,
    };
    this.fallbackChannels.set(channelId, { ...existing, ...patch });
  }
}

export const mixerBridge = new MixerBridge();
