import type { PluginAudioBlock, PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** Band-Übergänge der Offline-Tonregelung (Ein-Pol): low | mid | high. */
const LOW_SPLIT_HZ = 250;
const HIGH_SPLIT_HZ = 2500;

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

  /** Ein-Pol-Tiefpass-Zustand je Kanal (2 Filter) – Block-übergreifend. */
  private lowState: number[] = [];
  private midState: number[] = [];
  private coeffSampleRate = 0;
  private coeffLow = 0;
  private coeffHigh = 0;

  /**
   * Block-Verarbeitung des EQ: 3-Band-Tonregelung (low/mid/high in dB).
   *
   * Gespiegelt wird die **Kanal-EQ-Semantik der Engine**
   * (`audioEngine.setChannelEQ(track, 'low'|'mid'|'high', dB)`, siehe
   * `onParameter`) – dieselbe Bedeutung, nur dort, wo offline keine Engine
   * läuft. Keine zweite Wahrheit.
   *
   * Zwei Ein-Pol-Übergänge trennen die Bänder; bei Einheitsstellung (alle 0 dB)
   * wird **nicht** gefiltert, sondern der Block bit-gleich durchgereicht.
   * In-place, Zustand = zwei Floats je Kanal, keine Allokation im Block.
   */
  protected override onProcess(block: PluginAudioBlock): PluginAudioBlock {
    const sr = block.sampleRate > 0 ? block.sampleRate : 48000;
    const lowDb = this.clampValue(this.numberFromParameters('low', 0), -24, 24);
    const midDb = this.clampValue(this.numberFromParameters('mid', 0), -24, 24);
    const highDb = this.clampValue(this.numberFromParameters('high', 0), -24, 24);
    if (lowDb === 0 && midDb === 0 && highDb === 0) return block;

    if (this.coeffSampleRate !== sr) {
      this.coeffSampleRate = sr;
      this.coeffLow = Math.exp((-2 * Math.PI * LOW_SPLIT_HZ) / sr);
      this.coeffHigh = Math.exp((-2 * Math.PI * HIGH_SPLIT_HZ) / sr);
    }
    const cLow = this.coeffLow;
    const cHigh = this.coeffHigh;

    const gLow = Math.pow(10, lowDb / 20);
    const gMid = Math.pow(10, midDb / 20);
    const gHigh = Math.pow(10, highDb / 20);

    for (let c = 0; c < block.channels.length; c++) {
      const channel = block.channels[c];
      let low = this.lowState[c] ?? 0;
      let mid = this.midState[c] ?? 0;
      for (let i = 0; i < channel.length; i++) {
        const x = channel[i];
        low = (1 - cLow) * x + cLow * low;
        const rest = x - low;
        mid = (1 - cHigh) * rest + cHigh * mid;
        const high = rest - mid;
        channel[i] = low * gLow + mid * gMid + high * gHigh;
      }
      this.lowState[c] = low;
      this.midState[c] = mid;
    }
    return block;
  }

  protected override onParameter(parameter: PluginParameterValue): void {
    const value = this.numberParam(parameter, 0, -24, 24);
    // EQ ist ein Master-Insert (insertScope: 'master'), kein Kanal-EQ.
    // Parameter low/mid/high werden von setParameter() gespeichert und von
    // onProcess() gelesen. Für den Online-Pfad an die Engine delegieren,
    // korrekt gemapped auf die 3 Master-EQ-Bänder (low=0, mid=5, high=11).
    const bandMap: Record<string, { index: number; type: string; freq: number }> = {
      low: { index: 0, type: 'lowshelf', freq: 30 },
      mid: { index: 5, type: 'peaking', freq: 1000 },
      high: { index: 11, type: 'highshelf', freq: 16000 },
    };
    const b = bandMap[parameter.name];
    if (!b) return;
    const DEFAULT_EQ_FREQS = [30, 60, 120, 250, 500, 1000, 2000, 4000, 6000, 8000, 12000, 16000];
    const bands = DEFAULT_EQ_FREQS.map((f, i) => ({
      freq: f,
      gain: i === b.index ? value : 0,
      q: 1,
      type: i === b.index ? b.type : (i === 0 ? 'lowshelf' : i === 11 ? 'highshelf' : 'peaking'),
    }));
    this.audio.updateToneShiftEQ({ bands });
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'automate') {
      this.audio.automateEqBandGain(
        Number(command.payload?.band ?? 2),
        Number(command.payload?.gain ?? 6),
        Number(command.payload?.ramp ?? 0.5),
      );
      return { ok: true };
    }
    return super.onCommand(command);
  }
}
