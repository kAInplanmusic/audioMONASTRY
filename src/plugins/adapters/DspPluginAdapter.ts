import type { PluginAudioBlock, PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** Resonanz 0…1 wird auf Q 0,707…12 abgebildet (0 = neutral). */
const MIN_Q = 0.707;
const MAX_Q = 12;

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

  /** Biquad-Zustand (Transposed Direct Form II) je Kanal. */
  private z1: number[] = [];
  private z2: number[] = [];
  private coeffKey = '';
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;

  constructor() {
    super(DspPluginAdapter.MANIFEST);
  }

  /**
   * Block-Verarbeitung des DSP-Slots: resonanter Tiefpass (`cutoff`, `resonance`)
   * und Vorverstärkung mit Soft-Clip (`drive`).
   *
   * Dieselben Parameter, die `onParameter` an die Engine gibt
   * (`audioEngine.automateDsp('cutoff'|'resonance'|'drive', …)`) – offline der
   * einzige Ort, an dem sie wirken können. RBJ-Biquad: unbedingt stabil für
   * jede Grenzfrequenz unterhalb Nyquist; Koeffizienten nur bei Änderung neu.
   *
   * Neutral = transparent: `cutoff` oberhalb Nyquist und `drive` 0 ergibt
   * bit-gleiches Signal. In-place, Zustand = 2 Floats je Kanal.
   */
  protected override onProcess(block: PluginAudioBlock): PluginAudioBlock {
    const sr = block.sampleRate > 0 ? block.sampleRate : 48000;
    const nyquist = sr / 2;
    const cutoff = this.clampValue(this.numberFromParameters('cutoff', 20000), 20, nyquist);
    const resonance = this.clampValue(this.numberFromParameters('resonance', 0), 0, 1);
    const drive = this.clampValue(this.numberFromParameters('drive', 0), 0, 1);
    if (cutoff >= nyquist && drive === 0) return block;

    if (drive === 0 && cutoff < nyquist) {
      this.updateCoefficients(sr, cutoff, resonance);
      for (let c = 0; c < block.channels.length; c++) {
        const channel = block.channels[c];
        let z1 = this.z1[c] ?? 0;
        let z2 = this.z2[c] ?? 0;
        for (let i = 0; i < channel.length; i++) {
          const x = channel[i];
          const y = this.b0 * x + z1;
          z1 = this.b1 * x - this.a1 * y + z2;
          z2 = this.b2 * x - this.a2 * y;
          channel[i] = y;
        }
        this.z1[c] = z1;
        this.z2[c] = z2;
      }
      return block;
    }

    // Mit Drive: erst sanft übersteuern, dann filtern (Reihenfolge wie im Insert).
    // Normiert wird auf die Sättigungsgrenze (tanh), nicht auf den Vorverstärker –
    // sonst dämpft „Drive“ das Signal, statt es anzutreiben.
    const preGain = 1 + drive * 8;
    const norm = 1 / Math.tanh(preGain);
    if (cutoff < nyquist) this.updateCoefficients(sr, cutoff, resonance);
    const bypassFilter = cutoff >= nyquist;
    for (let c = 0; c < block.channels.length; c++) {
      const channel = block.channels[c];
      let z1 = this.z1[c] ?? 0;
      let z2 = this.z2[c] ?? 0;
      for (let i = 0; i < channel.length; i++) {
        const clipped = Math.tanh(channel[i] * preGain) * norm;
        if (bypassFilter) {
          channel[i] = clipped;
          continue;
        }
        const y = this.b0 * clipped + z1;
        z1 = this.b1 * clipped - this.a1 * y + z2;
        z2 = this.b2 * clipped - this.a2 * y;
        channel[i] = y;
      }
      this.z1[c] = z1;
      this.z2[c] = z2;
    }
    return block;
  }

  /** RBJ-Tiefpass; rechnet nur neu, wenn sich die Eckdaten geändert haben. */
  private updateCoefficients(sampleRate: number, cutoff: number, resonance: number): void {
    const q = MIN_Q + (MAX_Q - MIN_Q) * resonance;
    const key = `${sampleRate}|${cutoff}|${q}`;
    if (key === this.coeffKey) return;
    const w0 = (2 * Math.PI * cutoff) / sampleRate;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosW0) / 2) / a0;
    this.b1 = (1 - cosW0) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cosW0) / a0;
    this.a2 = (1 - alpha) / a0;
    this.coeffKey = key;
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
