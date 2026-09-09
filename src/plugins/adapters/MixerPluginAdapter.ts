import type { PluginManifest, PluginParameterValue } from '../plugin_interface';
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
