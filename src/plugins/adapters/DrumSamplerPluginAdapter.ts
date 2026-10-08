import type { PluginAudioBlock, PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** drumsamplerMONK – Drum-Machine, Patterns, Trigger, Samples (kanonische ID `drumsampler`). */
export class DrumSamplerPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'drumsampler',
    name: 'drumsamplerMONK',
    version: '1.0.0',
    kind: 'audio-source',
    capabilities: ['audio-source'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(DrumSamplerPluginAdapter.MANIFEST);
  }

  /**
   * Block-Verarbeitung für drumsampler:
   * Sample-Playback kann im Block ohne Sample-Daten nicht umgesetzt werden.
   * Deshalb wird hier nur Gain (0..2, Vorgabe 1) und Velocity-Skalierung (0..1, Vorgabe 1)
   * als Pegel-Steuerung implementiert. Pitch/Voice-Trigger werden bewusst nicht erfunden –
   * die echte Drum-Engine läuft im Worklet.
   * In-place, keine Allokation.
   */
  protected override onProcess(block: PluginAudioBlock): PluginAudioBlock {
    const gain = this.clampValue(this.numberFromParameters('gain', 1), 0, 2);
    const velocity = this.clampValue(this.numberFromParameters('velocity', 1), 0, 1);
    const factor = gain * velocity;
    if (factor === 1) return block;

    for (const channel of block.channels) {
      for (let i = 0; i < channel.length; i++) {
        channel[i] *= factor;
      }
    }
    return block;
  }

  protected override onParameter(parameter: PluginParameterValue): void {
    if (parameter.name === 'kit') {
      const kit = String(parameter.value ?? 'tr-808');
      void import('../../utils/audioEngine').then(({ audioEngine }) => {
        audioEngine.setDrumKit(kit);
      });
    }
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'pattern_random') {
      const { controlBus } = await import('../../core/events/ControlBus');
      controlBus.emit('monk:drum-pattern-random', undefined);
      return { ok: true };
    }
    if (command.name === 'trigger') {
      const start = () => { this.context?.audio.triggerEvent('channel2', 0.8); };
      this.scheduleSyncStart(start);
      return { ok: true, track: 'channel2' };
    }
    return super.onCommand(command);
  }
}
