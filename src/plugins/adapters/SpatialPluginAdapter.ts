import type { PluginManifest, PluginParameterValue } from '../plugin_interface';
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
