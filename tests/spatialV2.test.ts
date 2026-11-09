import { describe, expect, it } from 'vitest';
import {
  applySpatialMoveV2, createPerimeterSpeakers, createSpatialSceneV2,
  projectLegacySourcesV2, validateSpatialSceneV2,
} from '../src/core/spatial/v2/model';
import { calculateVbap2dGains, renderMonoVbap2dBlock } from '../src/core/spatial/v2/vbap2d';
import { resolveSpatialOutput } from '../src/core/spatial/v2/outputPolicy';

describe('spatialMONK V2 passive scene schema', () => {
  it('creates 16 virtual satellites in a 4x4 metre room, none mapped to hardware', () => {
    const scene = createSpatialSceneV2();
    expect(scene.speakers).toHaveLength(16);
    expect(scene.speakers.every((s) => s.outputChannel === null)).toBe(true);
    expect(validateSpatialSceneV2(scene)).toEqual([]);
  });

  it('places 16 speakers on square perimeter (1 metre spacing)', () => {
    const speakers = createPerimeterSpeakers({ widthM: 4, depthM: 4 }, 16);
    expect(speakers[0].positionM).toEqual({ x: -2, y: 2 });
    expect(speakers[4].positionM).toEqual({ x: 2, y: 2 });
    expect(speakers[8].positionM).toEqual({ x: 2, y: -2 });
    expect(speakers[12].positionM).toEqual({ x: -2, y: -2 });
    for (const s of speakers) expect(Math.max(Math.abs(s.positionM.x), Math.abs(s.positionM.y))).toBe(2);
  });

  it('rejects duplicate physical output mappings', () => {
    const scene = createSpatialSceneV2();
    scene.speakers[0].outputChannel = 3;
    scene.speakers[1].outputChannel = 3;
    expect(validateSpatialSceneV2(scene)).toContain('Duplicate physical output channel: 3');
  });

  it('applies a revisioned move immutably, stale commands fail closed', () => {
    const original = createSpatialSceneV2();
    original.objects.push({
      id: 'voice-1', pluginId: 'voice', channelId: 'channel6',
      kind: 'mono', positionM: { x: 0, y: 1 }, gainDb: 0,
      spread: 0, width: 1, muted: false, enabled: true, revision: 0,
    });
    const command = {
      kind: 'object.move' as const, opId: 'op-1', actorId: 'user-1',
      baseRevision: 0, objectId: 'voice-1', positionM: { x: 1, y: -1 },
    };
    const result = applySpatialMoveV2(original, command);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.revision).toBe(1);
    expect(result.scene.objects[0].revision).toBe(1);
    expect(original.objects[0].positionM).toEqual({ x: 0, y: 1 });
    expect(applySpatialMoveV2(result.scene, command)).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
  });

  it('projects existing v1 source metadata without touching old presets', () => {
    const scene = projectLegacySourcesV2([{ id: 7, name: 'Vox', az: 90, dist: 1, gain: 1, muted: false }]);
    expect(scene.objects[0].id).toBe('legacy-7');
    expect(scene.objects[0].positionM.x).toBeCloseTo(1);
    expect(scene.objects[0].positionM.y).toBeCloseTo(0);
    expect(validateSpatialSceneV2(scene)).toEqual([]);
  });
});

describe('2D VBAP geometry, offline sample renderer', () => {
  const scene = createSpatialSceneV2();
  const speakers = scene.speakers;

  it('uses no subwoofer as a directional VBAP speaker', () => {
    const layout = [...speakers, {
      ...speakers[0], id: 'sub-1', role: 'subwoofer' as const,
    }];
    const result = calculateVbap2dGains({ x: 1, y: 1 }, { x: 0, y: 0 }, layout);
    expect(result.at(-1)?.gain).toBe(0);
  });

  it('preserves equal-power normalization around the full circle', () => {
    for (let degree = 0; degree < 360; degree += 5) {
      const a = degree * Math.PI / 180;
      const g = calculateVbap2dGains({ x: Math.sin(a), y: Math.cos(a) }, { x: 0, y: 0 }, speakers);
      expect(g).toHaveLength(16);
      expect(g.every(({ gain }) => Number.isFinite(gain) && gain >= 0)).toBe(true);
      expect(g.reduce((sum, v) => sum + v.gain * v.gain, 0)).toBeCloseTo(1, 7);
      expect(g.filter((v) => v.gain > 0)).toHaveLength(degree % 90 === 45 ? 1 : g.filter((v) => v.gain > 0).length);
      expect(g.filter((v) => v.gain > 0).length).toBeLessThanOrEqual(2);
    }
  });

  it('produces continuous gains across 359->0 degrees', () => {
    const at = (degrees: number) => {
      const radians = degrees * Math.PI / 180;
      return calculateVbap2dGains({ x: Math.sin(radians), y: Math.cos(radians) }, scene.listenerM, speakers);
    };
    const a = at(359.9), b = at(0.1);
    const delta = a.reduce((sum, v, i) => sum + Math.abs(v.gain - b[i].gain), 0);
    expect(delta).toBeLessThan(0.05);
  });

  it('has a nearest-speaker fallback for a degenerate or sparse layout', () => {
    const sp = speakers.slice(0, 1);
    expect(calculateVbap2dGains({ x: 1, y: 0 }, scene.listenerM, sp)[0].gain).toBe(1);
    expect(calculateVbap2dGains({ x: 1, y: 0 }, scene.listenerM, [])[0]).toBeUndefined();
  });

  it('renders finite offline blocks with expected channel count', () => {
    const gains = calculateVbap2dGains({ x: 0, y: 1 }, scene.listenerM, speakers);
    const out = renderMonoVbap2dBlock(new Float32Array([1, 0.5, NaN]), gains);
    expect(out).toHaveLength(16);
    expect(out.every((ch) => ch.every(Number.isFinite))).toBe(true);
  });
});

describe('spatialMONK hardware capability fallback', () => {
  it('never claims 16 channel hardware on an unverified device', () => {
    expect(resolveSpatialOutput('spatial-main-exclusive', 16, null).mode).toBe('stereo-main');
    expect(resolveSpatialOutput('spatial-main-exclusive', 16, {
      deviceId: 'virtual', verifiedDiscreteOutputs: 32, isVerified: false,
    }).mode).toBe('stereo-main');
  });
  it('enables a verified 16+2 layout with 18 real device outputs', () => {
    expect(resolveSpatialOutput('spatial-main-exclusive', 18, {
      deviceId: 'interface-18', verifiedDiscreteOutputs: 18, isVerified: true,
    })).toEqual({ mode: 'spatial-main-exclusive', channels: 18, reason: null });
  });
});
