import type { PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** eqMONK – Parametrischer EQ / Frequenzbearbeitung (kanonische ID `eq`). */
export class EqPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'eq',
    name: 'eqMONK',
    version: '1.0.0',
    kind: 'audio-processor',
    capabilities: ['audio-processor'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(EqPluginAdapter.MANIFEST);
  }

  protected override onParameter(parameter: PluginParameterValue): void {
    const value = this.numberParam(parameter, 0, -24, 24);
    void import('../../utils/audioEngine').then(({ audioEngine }) => {
      if (parameter.name.startsWith('band')) {
        const band = Number(parameter.name.slice(4)) || 1;
        audioEngine.automateEqBandGain(Math.min(12, Math.max(1, band)), value, 0.05);
      } else {
        audioEngine.setChannelEQ('channel1', 'mid', value);
      }
    });
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'automate') {
      const { audioEngine } = await import('../../utils/audioEngine');
      audioEngine.automateEqBandGain(
        Number(command.payload?.band ?? 2),
        Number(command.payload?.gain ?? 6),
        Number(command.payload?.ramp ?? 0.5),
      );
      return { ok: true };
    }
    return super.onCommand(command);
  }
}
