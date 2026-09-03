/**
 * dropMONK – Mixer Integration Bridge
 * ==================================
 * Connect dropMONK to existing Mixer channels & state
 */

import type { DropProfile } from '../drop';

/**
 * Mixer Channel State (read from audioEngine)
 */
export interface MixerChannelState {
  id: string; // 'channel1', 'channel2', etc.
  label: string; // 'CH1', 'CH2', etc.
  level: number; // 0..1
  pan: number; // -1..1
  muted: boolean;
  soloed: boolean;
}

/**
 * Mixer Integration Bridge
 * Bridges dropMONK drop engine to mixer channels
 */
export class MixerBridge {
  /**
   * Get current mixer state
   * TODO: Integrate with audioEngine.getMixerState()
   */
  getCurrentMixerState(): MixerChannelState[] {
    // Placeholder: will connect to audioEngine
    // audioEngine should expose: getMixerChannels(), getMixerLevel(ch), etc.
    return [
      { id: 'channel1', label: 'CH1', level: 0.8, pan: 0, muted: false, soloed: false },
      { id: 'channel2', label: 'CH2', level: 0.6, pan: 0, muted: false, soloed: false },
      { id: 'channel3', label: 'CH3', level: 0.5, pan: 0, muted: false, soloed: false },
      { id: 'channel4', label: 'CH4', level: 0.7, pan: 0, muted: false, soloed: false },
      { id: 'channel5', label: 'CH5 (Master)', level: 1.0, pan: 0, muted: false, soloed: false },
    ];
  }

  /**
   * Set mixer level (crossfade)
   * TODO: Integrate with audioEngine.setMixerLevel()
   */
  setMixerLevel(channelId: string, level: number): void {
    if (level < 0 || level > 1) {
      console.error('Invalid mixer level:', level);
      return;
    }
    // audioEngine.setMixerLevel(channelId, level);
    console.log(`[MixerBridge] Set ${channelId} level to ${level}`);
  }

  /**
   * Set mixer pan
   */
  setMixerPan(channelId: string, pan: number): void {
    if (pan < -1 || pan > 1) {
      console.error('Invalid pan value:', pan);
      return;
    }
    // audioEngine.setMixerPan(channelId, pan);
    console.log(`[MixerBridge] Set ${channelId} pan to ${pan}`);
  }

  /**
   * Mute/unmute channel
   */
  setMixerMute(channelId: string, muted: boolean): void {
    // audioEngine.setMixerMute(channelId, muted);
    console.log(`[MixerBridge] Set ${channelId} mute to ${muted}`);
  }

  /**
   * Crossfade between two channels
   * Used for DJ Transitions
   */
  async crossfade(
    fromChannel: string,
    toChannel: string,
    duration: number = 2000
  ): Promise<void> {
    const steps = 50; // Number of interpolation steps
    const stepDuration = duration / steps;

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      const fromLevel = Math.max(0, 1 - progress);
      const toLevel = Math.min(1, progress);

      this.setMixerLevel(fromChannel, fromLevel);
      this.setMixerLevel(toChannel, toLevel);

      await new Promise((resolve) => setTimeout(resolve, stepDuration));
    }

    // Ensure final state
    this.setMixerLevel(fromChannel, 0);
    this.setMixerLevel(toChannel, 1);
  }

  /**
   * Get energy level from mixer (used for context analysis)
   * Simple: average of unmuted channel levels
   */
  getEnergyLevel(): number {
    const channels = this.getCurrentMixerState();
    const unmutedChannels = channels.filter((ch) => !ch.muted);

    if (unmutedChannels.length === 0) return 0;

    const avgLevel = unmutedChannels.reduce((sum, ch) => sum + ch.level, 0) / unmutedChannels.length;
    return Math.min(1, avgLevel * 1.2); // Slight boost for better detection
  }

  /**
   * Get active channels (not muted, non-zero level)
   */
  getActiveChannels(): MixerChannelState[] {
    return this.getCurrentMixerState().filter((ch) => !ch.muted && ch.level > 0.01);
  }
}

export const mixerBridge = new MixerBridge();
