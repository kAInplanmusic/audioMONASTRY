import type { PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** effectMONK – FX/Effektketten (kanonische ID `effect`). */
export class EffectPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'effect',
    name: 'effectMONK',
    version: '1.0.0',
    kind: 'audio-processor',
    capabilities: ['audio-processor'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(EffectPluginAdapter.MANIFEST);
  }

  protected override onParameter(parameter: PluginParameterValue): void {
    // Effektparameter laufen über den bestehenden Effect-Worklet-/AudioEngine-Pfad.
    void import('../../utils/audioEngine').then(({ audioEngine }) => {
      const value = this.numberParam(parameter, 0);
      switch (parameter.name) {
        case 'depth':
          audioEngine.automateEffect('depth', value, 0.05);
          break;
        case 'wet':
        case 'feedback':
        case 'rate':
        case 'bits':
        case 'sampleReduction':
          audioEngine.setEffectParams({ [parameter.name]: value });
          break;
        default:
          audioEngine.setEffectParam({ [parameter.name]: value });
      }
    });
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'automate') {
      const { audioEngine } = await import('../../utils/audioEngine');
      audioEngine.automateEffect(
        String(command.payload?.param ?? 'depth') as 'feedback' | 'depth' | 'wet',
        Number(command.payload?.value ?? 0.8),
        Number(command.payload?.ramp ?? 0.5),
      );
      return { ok: true };
    }
    return super.onCommand(command);
  }
}
