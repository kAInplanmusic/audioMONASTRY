import type { PluginAudioBlock, PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** masterMONK – Mastering-Dynamics, LUFS, PDC (kanonische ID `master`). */
export class MasterPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'master',
    name: 'masterMONK',
    version: '1.0.0',
    kind: 'audio-processor',
    capabilities: ['audio-processor'],
    latencySamples: 240, // 5 ms lookahead bei 48 kHz (Vertrag: intrinsicLatencyFrames 240)
    tailSamples: 0,
  };

  // Limiter-State (einfache Envelope-Follower + Soft-Knee-Clipping)
  private env = 0;
  private readonly attackCoeff = 0.99;   // ~5 ms bei 48 kHz
  private readonly releaseCoeff = 0.995; // ~50 ms bei 48 kHz

  constructor() {
    super(MasterPluginAdapter.MANIFEST);
  }

  protected override onParameter(parameter: PluginParameterValue): void {
    const value = this.numberParam(parameter, 0);
    if (parameter.name === 'masterVolumeDb') {
      this.audio.setMasterVolumeDb(Math.max(-48, Math.min(12, value)), 0.05);
    } else if (parameter.name === 'inputGain') {
      this.audio.updateMasterMe({ input_gain: value });
    }
  }

  /**
   * Block-Verarbeitung des Masters: Limiter mit Ceiling + einfacher
   * Kompression (strength/attack/release) sowie Soft-Knee-True-Peak-Limiter.
   *
   * Parameter aus `me` (MasterMe):
   *   gain:             lineare Vorverstärkung (0…2)
   *   limiter_threshold: Ceiling in dB (-6…0)
   *   strength:         Kompressionsstärke (0…100)
   *   attack:           Attack-Zeit in ms (0.5…30)
   *   release:          Release-Zeit in ms (20…300)
   *
   * In-place, ohne Allokation (Adapter-Vertrag: `process()` ist echtzeit-sicher).
   */
  protected override onProcess(block: PluginAudioBlock): PluginAudioBlock {
    const gain = this.clampValue(this.numberFromParameters('gain', 1), 0, 2);
    const ceilingDb = this.clampValue(this.numberFromParameters('limiter_threshold', -1), -6, 0);
    const strength = this.clampValue(this.numberFromParameters('strength', 60), 0, 100) / 100;
    const attackMs = this.clampValue(this.numberFromParameters('attack', 5), 0.5, 30);
    const releaseMs = this.clampValue(this.numberFromParameters('release', 80), 20, 300);

    // Ceiling in linear Gain
    const ceiling = Math.pow(10, ceilingDb / 20);

    // Attack/Release-Koeffizienten aktualisieren (per Block, nicht pro Sample – akzeptabler Kompromiss)
    const attackCoeff = Math.exp(-1 / (attackMs * 0.048));   // 48 kHz ≈ 0.048 pro ms
    const releaseCoeff = Math.exp(-1 / (releaseMs * 0.048));

    for (const channel of block.channels) {
      for (let i = 0; i < channel.length; i++) {
        let sample = channel[i] * gain;

        // Envelope-Follower (Peak)
        const abs = Math.abs(sample);
        if (abs > this.env) {
          this.env = attackCoeff * this.env + (1 - attackCoeff) * abs;
        } else {
          this.env = releaseCoeff * this.env + (1 - releaseCoeff) * abs;
        }

        // Kompression: oberhalb von Ceiling wird gedämft
        if (this.env > ceiling) {
          const reduction = ceiling / Math.max(this.env, 1e-9);
          // Stärke mildern: bei strength=0 kein Limiting, bei 100 hartes Limiting
          const mix = 1 - strength * (1 - reduction);
          sample *= mix;
        }

        // Soft-Knee True-Peak-Clipping als Sicherheitsnetz
        if (sample > 1) sample = 1;
        if (sample < -1) sample = -1;

        channel[i] = sample;
      }
    }
    return block;
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'preset') {
      const { MASTERING_PRESETS } = await import('../../data/masteringPresets');
      const wanted = String(command.payload?.preset ?? '').toLowerCase();
      const entries = Object.entries(MASTERING_PRESETS) as [
        string,
        { master_me: Record<string, number>; tone_shift: unknown },
      ][];
      const match = entries.find(([k]) => k.toLowerCase() === wanted) ?? entries[0];
      if (match) {
        const preset = match[1];
        this.audio.updateMasterMe(preset.master_me);
        this.audio.updateToneShiftEQ(preset.tone_shift as never);
        return { ok: true, preset: match[0] };
      }
      return { ok: false };
    }
    return super.onCommand(command);
  }
}
