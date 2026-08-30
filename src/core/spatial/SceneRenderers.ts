/**
 * audioMONASTRY · Spatial Scene Renderer (Backend-unabhängig)
 * ============================================================
 * Renderer kennen keine Interface-spezifischen Details. Sie bekommen eine
 * SpatialScene und liefern einen mehrkanaligen AudioBuffer zurück.
 */
import type { IAudioBuffer } from '../audio/types';
import type { SpatialScene } from './SpatialScene';
import { getOutputLayout } from './layouts';

export type SpatialRendererKind = 'stereo' | 'vbap' | 'ambisonics' | 'hrtf';

export interface ISpatialSceneRenderer {
  readonly kind: SpatialRendererKind;
  readonly outputLayout: string;
  render(scene: SpatialScene, input: IAudioBuffer): IAudioBuffer;
}

abstract class BaseSceneRenderer implements ISpatialSceneRenderer {
  abstract readonly kind: SpatialRendererKind;
  abstract readonly outputLayout: string;

  render(scene: SpatialScene, input: IAudioBuffer): IAudioBuffer {
    const layout = getOutputLayout(scene.outputLayout) ?? getOutputLayout(this.outputLayout);
    if (!layout) return input.clone();
    const out = input.createEmpty();
    out.channelData = Array.from({ length: layout.channelCount }, (_, ch) => {
      const src = input.channelData[ch % input.numberOfChannels] ?? input.channelData[0];
      const dest = new Float32Array(input.length);
      dest.set(src);
      return dest;
    });
    return out;
  }
}

export class SceneStereoRenderer extends BaseSceneRenderer {
  readonly kind = 'stereo' as const;
  readonly outputLayout = 'stereo';
}

export class SceneVbapRenderer extends BaseSceneRenderer {
  readonly kind = 'vbap' as const;
  readonly outputLayout = '10.0';
}

export class SceneAmbisonicsRenderer extends BaseSceneRenderer {
  readonly kind = 'ambisonics' as const;
  readonly outputLayout = '10.0';
}

export class SceneHrtfRenderer extends BaseSceneRenderer {
  readonly kind = 'hrtf' as const;
  readonly outputLayout = 'stereo';
}
