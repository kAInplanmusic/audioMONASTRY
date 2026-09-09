import type { PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** masterMONK – Mastering-Dynamics, LUFS, PDC (kanonische ID `master`). */
export class MasterPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'master',
    name: 'masterMONK',
    version: '1.0.0',
    kind: 'audio-processor',
    capabilities: ['audio-processor'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(MasterPluginAdapter.MANIFEST);
  }

  protected override onParameter(parameter: PluginParameterValue): void {
    const value = this.numberParam(parameter, 0);
    void import('../../utils/audioEngine').then(({ audioEngine }) => {
      if (parameter.name === 'masterVolumeDb') {
        audioEngine.setMasterVolumeDb(Math.max(-48, Math.min(12, value)), 0.05);
      } else if (parameter.name === 'inputGain') {
        audioEngine.updateMasterMe({ input_gain: value });
      }
    });
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'preset') {
      const { MASTERING_PRESETS } = await import('../../data/masteringPresets');
      const { audioEngine } = await import('../../utils/audioEngine');
      const wanted = String(command.payload?.preset ?? '').toLowerCase();
      const entries = Object.entries(MASTERING_PRESETS) as [
        string,
        { master_me: Record<string, number>; tone_shift: unknown },
      ][];
      const match = entries.find(([k]) => k.toLowerCase() === wanted) ?? entries[0];
      if (match) {
        const preset = match[1];
        audioEngine.updateMasterMe(preset.master_me);
        audioEngine.updateToneShiftEQ(preset.tone_shift as never);
        return { ok: true, preset: match[0] };
      }
      return { ok: false };
    }
    return super.onCommand(command);
  }
}
