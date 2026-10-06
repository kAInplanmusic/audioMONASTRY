import type { PluginAudioBlock, PluginManifest, PluginParameterValue } from '../plugin_interface';
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

  /**
   * Block-Verarbeitung des Effekts: Bit-Tiefe (`bits`) und Dry/Wet (`wet`).
   *
   * Bewusst dieselben Parameter, die `onParameter` schon an die Engine gibt –
   * keine zweite Wahrheit, dieselbe Semantik, nur an der Stelle, an der offline
   * keine Engine läuft. Stateless, in-place, ohne Allokation.
   *
   * Neutral heißt transparent: volle Bit-Tiefe (>= 16) ergibt bit-gleiches
   * Signal, unabhängig von `wet`.
   */
  protected override onProcess(block: PluginAudioBlock): PluginAudioBlock {
    const bits = this.clampValue(this.numberFromParameters('bits', 16), 1, 16);
    const wet = this.clampValue(this.numberFromParameters('wet', 1), 0, 1);
    if (bits >= 16) return block;

    const step = Math.pow(2, bits - 1);
    for (const channel of block.channels) {
      for (let i = 0; i < channel.length; i++) {
        const dry = channel[i];
        const quantized = Math.round(dry * step) / step;
        channel[i] = dry + (quantized - dry) * wet;
      }
    }
    return block;
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
        // FEAT-P3-002: HQ-Reverb (effectMONK) im hörbaren V2-Pfad.
        case 'reverbEnabled':
          audioEngine.setOptionalReverb({ enabled: value >= 0.5 });
          break;
        case 'reverbMix':
          audioEngine.setOptionalReverb({ mix: value });
          break;
        case 'reverbDecayS':
          audioEngine.setOptionalReverb({ decayS: value });
          break;
        case 'reverbDamping':
          audioEngine.setOptionalReverb({ damping: value });
          break;
        case 'reverbSizeScale':
          audioEngine.setOptionalReverb({ sizeScale: value });
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
    if (command.name === 'optional-dsp') {
      // FEAT-P3-002: HQ-Reverb (4-Leitungs-FDN) als optionale Master-Einheit.
      const { audioEngine } = await import('../../utils/audioEngine');
      const payload = command.payload ?? {};
      audioEngine.setOptionalReverb({
        enabled: payload.enabled === undefined ? undefined : Boolean(payload.enabled),
        mix: payload.mix === undefined ? undefined : Number(payload.mix),
        decayS: payload.decayS === undefined ? undefined : Number(payload.decayS),
        damping: payload.damping === undefined ? undefined : Number(payload.damping),
        sizeScale: payload.sizeScale === undefined ? undefined : Number(payload.sizeScale),
      });
      return { ok: true, block: 'hq-reverb' };
    }
    return super.onCommand(command);
  }
}
