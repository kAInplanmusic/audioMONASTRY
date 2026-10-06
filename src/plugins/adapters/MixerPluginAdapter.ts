import type { PluginAudioBlock, PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** mixerMONK – Mixing, Routing und Raum (kanonische ID `mixer`). */
export class MixerPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'mixer',
    name: 'mixerMONK',
    version: '1.0.0',
    kind: 'audio-mixer',
    capabilities: ['audio-mixer', 'audio-router'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(MixerPluginAdapter.MANIFEST);
  }

  /**
   * Block-Verarbeitung: Kanal-Gains/Pan als Summe.
   *
   * Parameter (aus `this.parameters`):
   *   `gain` 0 … 2 (Vorgabe 1). Wirkt auf **alle** Kanäle des Blocks.
   *   `pan`  -1 … +1, wie `spatial`.
   *   `gain:0`, `gain:1`, … `pan:0`, `pan:1`, … je Kanal – dieselbe
   *          Namenskonvention wie `onParameter` (`gain:`/`pan:` + Kanalname).
   *          Der numerische Index ist der Kanalindex im Block.
   *
   * Gespiegelt wird `audio.setChannelGain()` / `audio.setChannelPan()`
   * (siehe `onParameter`) – dieselbe Bedeutung, nur dort, wo offline keine
   * Engine läuft. Keine zweite Wahrheit.
   *
   * Ohne Parameter wird der Block **bit-gleich** durchgereicht.
   * In-place, keine Allokation im Block.
   */
  protected override onProcess(block: PluginAudioBlock): PluginAudioBlock {
    const globalGain = this.clampValue(this.numberFromParameters('gain', 1), 0, 2);
    const pan = this.clampValue(this.numberFromParameters('pan', 0), -1, 1);
    const ready = globalGain !== 1 || pan !== 0 || this.hasPerChannelParameters();
    if (!ready) return block;

    const channels = block.channels;
    const count = channels.length;

    // Pan zuerst, damit der Kanal-Gain das fertige Panorama skaliert.
    if (pan !== 0) {
      if (count >= 2) {
        const angle = ((pan + 1) * Math.PI) / 4;
        const gLeft = Math.cos(angle);
        const gRight = Math.sin(angle);
        const left = channels[0];
        const right = channels[1];
        for (let i = 0; i < left.length; i++) {
          left[i] *= gLeft;
          right[i] *= gRight;
        }
      } else if (count === 1) {
        channels[0].fill(0);
      }
    }

    for (let c = 0; c < count; c++) {
      const channel = channels[c];
      const channelGain = this.clampValue(
        this.numberFromParameters(`gain:${c}`, globalGain),
        0,
        2,
      );
      if (channelGain === 1) continue;
      for (let i = 0; i < channel.length; i++) channel[i] *= channelGain;
    }
    return block;
  }

  /** true, sobald irgendein `gain:<n>` / `pan:<n>` gesetzt ist. */
  private hasPerChannelParameters(): boolean {
    for (const key of Object.keys(this.parameters)) {
      if (/^(?:gain|pan):\d+$/.test(key)) return true;
    }
    return false;
  }

  protected override onParameter(parameter: PluginParameterValue): void {
    const audio = this.context?.audio;
    if (!audio) return;

    const { name } = parameter;
    const value = this.numberParam(parameter, 0);

    if (name === 'masterGain') {
      audio.setMasterVolume(Math.max(0, Math.min(1.5, value)));
      return;
    }
    if (name.startsWith('gain:')) {
      audio.setChannelGain(name.slice(5), Math.max(0, Math.min(1.5, value)));
      return;
    }
    if (name.startsWith('pan:')) {
      audio.setChannelPan(name.slice(4), Math.max(-1, Math.min(1, value)));
      return;
    }
    if (name.startsWith('eqLow:')) {
      audio.setChannelEQ(name.slice(6), 'low', value);
      return;
    }
    if (name.startsWith('eqMid:')) {
      audio.setChannelEQ(name.slice(6), 'mid', value);
      return;
    }
    if (name.startsWith('eqHigh:')) {
      audio.setChannelEQ(name.slice(7), 'high', value);
    }
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'fadeInMain') {
      const { audioEngine } = await import('../../utils/audioEngine');
      const track = String(command.payload?.track ?? 'channel1');
      const seconds = Number(command.payload?.seconds ?? 4);
      audioEngine.fadeChannelToMain(track as import('../../types').TrackType, seconds, 0);
      return { ok: true, track, seconds };
    }
    if (command.name === 'loadTrackSample') {
      const { audioEngine } = await import('../../utils/audioEngine');
      const track = String(command.payload?.track ?? 'channel1');
      const url = command.payload?.url ? String(command.payload.url) : null;
      await audioEngine.loadTrackSample(track as import('../../types').TrackType, url);
      return { ok: true, track, url };
    }
    return super.onCommand(command);
  }
}
