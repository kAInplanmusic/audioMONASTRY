import type { PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';
import type { TrackType } from '../../types';

/** syntisamplerMONK – Synthesizer + Sampler + MCP-Steuerung (kanonische ID `syntisampler`). */
export class SyntiSamplerPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'syntisampler',
    name: 'syntisamplerMONK',
    version: '1.0.0',
    kind: 'audio-source',
    capabilities: ['audio-source', 'compute', 'ai'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(SyntiSamplerPluginAdapter.MANIFEST);
  }

  protected override onParameter(parameter: PluginParameterValue): void {
    if (parameter.name === 'note') {
      const freq = this.numberParam(parameter, 440, 20, 20000);
      void import('../../utils/audioEngine').then(({ audioEngine }) => {
        audioEngine.noteOnWorklet(freq, 0.8, 'saw');
      });
    }
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    const { controlBus } = await import('../../core/events/ControlBus');

    switch (command.name) {
      case 'trigger':
        this.context?.audio.triggerEvent('channel5', 0.8);
        return { ok: true, track: 'channel5' };
      case 'pattern_four':
      case 'pattern_random':
      case 'pattern_break': {
        const preset = command.name.replace('pattern_', '');
        controlBus.emit('monk:mcp-pattern', { preset });
        return { ok: true, preset };
      }
      case 'optional-voice': {
        // FEAT-P3-002: Phase-Distortion-Oszillator (Casio CZ) als V2-Quelle.
        const { audioEngine } = await import('../../utils/audioEngine');
        const channel = (command.payload?.channel ?? 'channel5') as TrackType;
        const freq = Number(command.payload?.freq ?? 440);
        const amount = Number(command.payload?.amount ?? 0.6);
        audioEngine.setOptionalSynthVoice(channel, 'phase', freq, { amount });
        return { ok: true, block: 'phase-distortion', channel };
      }
      default:
        return super.onCommand(command);
    }
  }
}
