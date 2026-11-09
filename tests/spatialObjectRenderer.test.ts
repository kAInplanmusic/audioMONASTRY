import { describe, expect, it } from 'vitest';
import { createSpatialSceneV2 } from '../src/core/spatial/v2/model';
import { renderSpatialObjectsOffline } from '../src/core/spatial/v2/objectRenderer';

const add = (scene: ReturnType<typeof createSpatialSceneV2>, id: string, x: number, y: number) => {
  scene.objects.push({
    id, pluginId: 'voice', channelId: 'channel6', kind: 'mono',
    positionM: { x, y }, gainDb: 0, spread: 0, width: 1,
    enabled: true, muted: false, revision: 0,
  });
};

describe('SP-P1-02 offline multi-object spatial render', () => {
  it('routes two INDEPENDENT sources to front and back, not a stereo master clone', () => {
    const scene = createSpatialSceneV2();
    add(scene, 'front-voice', 0, 1);
    add(scene, 'rear-voice', 0, -1);
    const result = renderSpatialObjectsOffline(scene, [
      { objectId: 'front-voice', samples: new Float32Array([0.5, 0]) },
      { objectId: 'rear-voice', samples: new Float32Array([0, 0.25]) },
    ], 2);
    expect(result.channels).toHaveLength(16);
    // Physical perimeter at 4x4 m: front = index2, back = index10.
    expect(result.channels[2][0]).toBeCloseTo(0.5, 6);
    expect(result.channels[2][1]).toBeCloseTo(0, 6);
    expect(result.channels[10][0]).toBeCloseTo(0, 6);
    expect(result.channels[10][1]).toBeCloseTo(0.25, 6);
    const sumFirst = result.channels.reduce((s, buf) => s + buf[0] * buf[0], 0);
    const sumSecond = result.channels.reduce((s, buf) => s + buf[1] * buf[1], 0);
    expect(sumFirst).toBeCloseTo(0.25, 6);
    expect(sumSecond).toBeCloseTo(0.0625, 6);
  });

  it('never sends positional energy directly into an LFE channel', () => {
    const scene = createSpatialSceneV2();
    add(scene, 'mono', 0, 1);
    scene.speakers.push({
      id: 'sub-1', role: 'subwoofer', positionM: { x: 0, y: 0 },
      outputChannel: null, trimDb: 0, delayMs: 0, polarity: 1,
    });
    const out = renderSpatialObjectsOffline(scene, [{ objectId: 'mono', samples: new Float32Array([0.75]) }], 1);
    expect(out.channels[16][0]).toBe(0);
  });

  it('preserves mute and rejects unknown/duplicate objects instead of guessing', () => {
    const scene = createSpatialSceneV2();
    add(scene, 'voice', 0, 1);
    scene.objects[0].muted = true;
    const silence = renderSpatialObjectsOffline(scene, [{ objectId: 'voice', samples: new Float32Array([1]) }], 1);
    expect(silence.channels.every((buf) => buf[0] === 0)).toBe(true);
    expect(() => renderSpatialObjectsOffline(scene, [
      { objectId: 'missing', samples: new Float32Array([1]) },
    ], 1)).toThrow('Unregistered object');
    expect(() => renderSpatialObjectsOffline(scene, [
      { objectId: 'voice', samples: new Float32Array([1]) },
      { objectId: 'voice', samples: new Float32Array([1]) },
    ], 1)).toThrow('Duplicate audio block');
  });

  it('does not silently fold stereo/bed audio into a mono object', () => {
    const scene = createSpatialSceneV2();
    add(scene, 'stereo', 1, 1);
    scene.objects[0].kind = 'stereo-pair';
    expect(() => renderSpatialObjectsOffline(scene, [
      { objectId: 'stereo', samples: new Float32Array([1]) },
    ], 1)).toThrow('explicit decomposition policy');
  });
});
