import type { PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** dspMONK – DSP/Processing-Nodes, Worklet-Kette, Dynamics (kanonische ID `dsp`). */
export class DspPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'dsp',
    name: 'dspMONK',
    version: '1.0.0',
    kind: 'audio-processor',
    capabilities: ['audio-processor'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(DspPluginAdapter.MANIFEST);
  }

  protected override onParameter(parameter: PluginParameterValue): void {
    const value = this.numberParam(parameter, 0);
    void import('../../utils/audioEngine').then(({ audioEngine }) => {
      switch (parameter.name) {
        case 'drive':
        case 'cutoff':
        case 'resonance':
        case 'modIndex':
        case 'gain':
          audioEngine.automateDsp(parameter.name as 'drive', value, 0.05);
          break;
        case 'lfoRate':
        case 'lfoDepth':
          audioEngine.setDspParam({ [parameter.name]: value });
          break;
        // FEAT-P3-002: Modulations-Matrix (dspMONK) im hörbaren V2-Pfad.
        case 'modEnabled':
          audioEngine.setOptionalModMatrix({ enabled: value >= 0.5 });
          break;
        case 'modRate':
        case 'modDepth':
          audioEngine.setOptionalModMatrix({ [parameter.name === 'modRate' ? 'rate' : 'depth']: value });
          break;
        default:
          audioEngine.setDspParam({ [parameter.name]: value });
      }
    });
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'automate') {
      const { audioEngine } = await import('../../utils/audioEngine');
      audioEngine.automateDsp(
        String(command.payload?.param ?? 'drive') as 'drive',
        Number(command.payload?.value ?? 0.7),
        Number(command.payload?.ramp ?? 0.5),
      );
      return { ok: true };
    }
    if (command.name === 'optional-dsp') {
      // FEAT-P3-002: Modulations-Matrix (LFO → Master-Gain).
      const { audioEngine } = await import('../../utils/audioEngine');
      const payload = command.payload ?? {};
      audioEngine.setOptionalModMatrix({
        enabled: payload.enabled === undefined ? undefined : Boolean(payload.enabled),
        rate: payload.rate === undefined ? undefined : Number(payload.rate),
        depth: payload.depth === undefined ? undefined : Number(payload.depth),
      });
      return { ok: true, block: 'mod-matrix' };
    }
    return super.onCommand(command);
  }
}
