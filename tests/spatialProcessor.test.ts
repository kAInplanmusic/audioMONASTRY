import { describe, expect, it } from 'vitest';
import {
  azToStereoGains,
  distanceGain,
  distanceLowpassCoef,
  itdSamples,
} from '../src/audio/worklets/spatialProcessor';
import { migrateLegacySpatialPreset } from '../src/types';

describe('spatialProcessor DSP (MVP)', () => {
  it('equal-power Panning: -90° links, 0° Mitte, +90° rechts', () => {
    expect(azToStereoGains(-90).left).toBeCloseTo(1, 5);
    expect(azToStereoGains(-90).right).toBeCloseTo(0, 5);
    expect(azToStereoGains(0).left).toBeCloseTo(Math.SQRT1_2, 5);
    expect(azToStereoGains(0).right).toBeCloseTo(Math.SQRT1_2, 5);
    expect(azToStereoGains(90).left).toBeCloseTo(0, 5);
    expect(azToStereoGains(90).right).toBeCloseTo(1, 5);
  });

  it('Listener-Rotation verschiebt das Azimut-Bild', () => {
    // Quelle bei 0°, Kopf um -90° gedreht → Quelle erscheint rechts (+90).
    const g = azToStereoGains(0, -90);
    expect(g.right).toBeCloseTo(1, 5);
    expect(g.left).toBeCloseTo(0, 5);
  });

  it('ITD: 0° = keine Verzögerung, +90° verzögert links, -90° verzögert rechts', () => {
    expect(itdSamples(0, 48000)).toBe(0);
    expect(itdSamples(90, 48000)).toBeGreaterThan(0);
    expect(itdSamples(-90, 48000)).toBeLessThan(0);
    expect(itdSamples(90, 48000)).toBeCloseTo(Math.round(0.00063 * 48000), 0);
    expect(itdSamples(-90, 48000)).toBeCloseTo(-itdSamples(90, 48000), 0);
  });

  it('Distanz-Dämpfung: 0 → 1, 1 → 0.5, monoton fallend', () => {
    expect(distanceGain(0)).toBeCloseTo(1, 5);
    expect(distanceGain(1)).toBeCloseTo(0.5, 5);
    expect(distanceGain(3)).toBeLessThan(distanceGain(1));
    expect(distanceGain(NaN)).toBeCloseTo(0.5, 5);
  });

  it('Distanz-Lowpass: nah = hoher Koeffizient (hell), fern = niedrig (dumpf)', () => {
    expect(distanceLowpassCoef(0, 48000)).toBeGreaterThan(distanceLowpassCoef(5, 48000));
    expect(distanceLowpassCoef(0, 48000)).toBeGreaterThan(0);
    expect(distanceLowpassCoef(5, 48000)).toBeLessThan(1);
  });
});

describe('spatialMONK Preset-Migration', () => {
  it('mappt altes Node-Format auf SpatialSceneState', () => {
    const migrated = migrateLegacySpatialPreset({
      global: { quality: 'high', listenerRot: 30, hrtf: 'user/default' },
      nodes: [
        { id: 7, label: 'Vox', x: -0.5, y: 0.6, active: true },
        { id: 8, label: 'Pad', az: 90, dist: 2, gain: 0.6, active: false },
      ],
    });
    expect(migrated.version).toBe('spatialMONK-v1');
    expect(migrated.global.quality).toBe('high');
    expect(migrated.sources).toHaveLength(2);
    expect(migrated.sources[0].az).toBeCloseTo(-45, 0);
    expect(migrated.sources[0].muted).toBe(false);
    expect(migrated.sources[1].muted).toBe(true);
    expect(migrated.sources[1].dist).toBe(2);
  });

  it('liefert Defaults bei leerem Alt-Preset', () => {
    const migrated = migrateLegacySpatialPreset({});
    expect(migrated.version).toBe('spatialMONK-v1');
    expect(migrated.global.quality).toBe('medium');
    expect(migrated.sources).toEqual([]);
  });
});
