import type { PluginManifest, PluginParameterValue } from '../plugin_interface';
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
      this.context?.audio.triggerEvent('channel2', 0.8);
      return { ok: true, track: 'channel2' };
    }
    return super.onCommand(command);
  }
}
