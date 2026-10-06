import type { PluginAudioBlock, PluginManifest, PluginParameterValue } from '../plugin_interface';
import { BasePluginAdapter } from './BasePluginAdapter';

/** spatialMONK – Spatial Audio, 2.1/N.x, HRTF (kanonische ID `spatial`). */
export class SpatialPluginAdapter extends BasePluginAdapter {
  public static readonly MANIFEST: PluginManifest = {
    id: 'spatial',
    name: 'spatialMONK',
    version: '1.0.0',
    kind: 'audio-router',
    capabilities: ['spatial', 'audio-router'],
    latencySamples: 0,
    tailSamples: 0,
  };

  constructor() {
    super(SpatialPluginAdapter.MANIFEST);
  }

  /**
   * Block-Verarbeitung: Pan/Breite je Kanal.
   *
   * Parameter (aus `this.parameters`, gesetzt über `restore()`):
   *   `pan`   -1 (links) … 0 (Mitte) … +1 (rechts). Bei einkanaligem Material
   *           entspricht `pan = -1` „alles auf links“.
   *   `width` 0 (Mono/Summe) … 1 (unverändert) … 2 (Breite verdoppelt).
   *
   * Semantik gespiegelt aus `setSpatialMode`/`setSpatialSetup` (onParameter/
   * onCommand) – dieselbe Bedeutung, nur dort, wo offline keine Engine läuft.
   * Keine zweite Wahrheit.
   *
   * Ohne Parameter (pan = 0, width = 1) wird der Block **bit-gleich**
   * durchgereicht. In-place, keine Allokation im Block.
   */
  protected override onProcess(block: PluginAudioBlock): PluginAudioBlock {
    const pan = this.clampValue(this.numberFromParameters('pan', 0), -1, 1);
    const width = this.clampValue(this.numberFromParameters('width', 1), 0, 2);
    if (pan === 0 && width === 1) return block;

    const channels = block.channels;
    const count = channels.length;

    // Width: Abweichung vom Mittenbild (M = (L+R)/2) wird skaliert.
    if (width !== 1 && count >= 2) {
      const left = channels[0];
      const right = channels[1];
      for (let i = 0; i < left.length; i++) {
        const mid = (left[i] + right[i]) * 0.5;
        left[i] = mid + (left[i] - mid) * width;
        right[i] = mid + (right[i] - mid) * width;
      }
    }

    // Pan: Stereo-Panorama (konstanter Leistungsanteil, -3 dB in der Mitte).
    if (pan !== 0) {
      if (count >= 2) {
        const angle = ((pan + 1) * Math.PI) / 4; // -1 -> 0, 0 -> π/4, +1 -> π/2
        const gLeft = Math.cos(angle);
        const gRight = Math.sin(angle);
        const left = channels[0];
        const right = channels[1];
        for (let i = 0; i < left.length; i++) {
          left[i] *= gLeft;
          right[i] *= gRight;
        }
      } else if (count === 1) {
        // Einkanalig: keine Richtung darstellbar, Lautstärke muss erhalten
        // bleiben (sonst wäre Pan ein versteckter Fader).
        channels[0].fill(0);
      }
    }
    return block;
  }

  protected override onParameter(parameter: PluginParameterValue): void {
    // Spatial-Rendering läuft über den bestehenden Spatial-/Worklet-Pfad.
    void import('../../utils/audioEngine').then(({ audioEngine }) => {
      if (parameter.name === 'setup') {
        audioEngine.setSpatialSetup(String(parameter.value));
      } else if (parameter.name === 'mode') {
        audioEngine.setSpatialMode(parameter.value as 'ON_TOP' | 'SEPARATION');
      }
    });
  }

  protected override async onCommand(command: {
    name: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    if (command.name === 'setup') {
      const { audioEngine } = await import('../../utils/audioEngine');
      audioEngine.setSpatialSetup(String(command.payload?.setup ?? 'stereo'));
      return { ok: true };
    }
    if (command.name === 'mode') {
      const { audioEngine } = await import('../../utils/audioEngine');
      audioEngine.setSpatialMode((command.payload?.mode ?? 'SEPARATION') as 'ON_TOP' | 'SEPARATION');
      return { ok: true };
    }
    return super.onCommand(command);
  }
}
