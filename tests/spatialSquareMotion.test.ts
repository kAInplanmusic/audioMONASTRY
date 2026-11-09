import { describe, expect, it } from 'vitest';
import {
  SQUARE_SPEAKER_COUNTS, assertSquareRoom,
  calculateSquarePerimeterSpeakers, proposeSquareCalibration,
} from '../src/core/spatial/v2/squareRoom';
import {
  SPATIAL_MOTION_OPTIONS, parseSpatialMotionText, positionAtSpatialTime,
  type SpatialMotionPlan,
} from '../src/core/spatial/v2/motion';
import { getOutputLayout } from '../src/core/spatial/layouts';
import { getSetup } from '../src/utils/spatialMath';

describe('Square room – physical metres and ear-height channel layout', () => {
  it('requires width == depth; rejects rectangular rooms', () => {
    expect(assertSquareRoom({ widthM: 4, depthM: 4 })).toBe(4);
    expect(() => assertSquareRoom({ widthM: 4, depthM: 5 })).toThrow();
    expect(() => assertSquareRoom({ widthM: 0, depthM: 0 })).toThrow();
  });

  for (const count of SQUARE_SPEAKER_COUNTS) {
    it('keeps ' + count + ' satellites on the square perimeter with real coordinates', () => {
      const list = calculateSquarePerimeterSpeakers(4, count, 2);
      expect(list).toHaveLength(count + 2);
      const sat = list.slice(0, count);
      for (const sp of sat) {
        const { x, y } = sp.positionM;
        expect(Math.abs(x)).toBeLessThanOrEqual(2);
        expect(Math.abs(y)).toBeLessThanOrEqual(2);
        expect(Math.max(Math.abs(x), Math.abs(y))).toBeCloseTo(2, 5);
        expect(sp.outputChannel).toBeNull();
      }
      expect(list.slice(count).every((sp) => sp.role === 'subwoofer')).toBe(true);
      expect(4 * 4 / count).toBeGreaterThan(0);
    });
  }

  it('uses exact 16-LS positions at each metre on the 4m square perimeter', () => {
    const speakers = calculateSquarePerimeterSpeakers(4, 16);
    expect(speakers[0].positionM).toEqual({ x: -2, y: 2 });
    expect(speakers[2].positionM).toEqual({ x: 0, y: 2 });
    expect(speakers[4].positionM).toEqual({ x: 2, y: 2 });
    expect(speakers[8].positionM).toEqual({ x: 2, y: -2 });
    expect(speakers[12].positionM).toEqual({ x: -2, y: -2 });
  });

  it('calculates nonnegative simulated delay alignment without modifying hardware', () => {
    const speakers = calculateSquarePerimeterSpeakers(4, 16, 1);
    const corrections = proposeSquareCalibration(speakers);
    expect(corrections).toHaveLength(16);
    expect(corrections.every((c) => c.relativeDelayMs >= 0 && c.relativeTrimDb <= 0)).toBe(true);
    expect(corrections.some((c) => c.relativeDelayMs > 0)).toBe(true);
    expect(speakers.every((s) => s.delayMs === 0 && s.trimDb === 0)).toBe(true);
  });

  for (const subs of [0, 1, 2] as const) {
    it('registers 16.' + subs + ' both in spatial setup and V2 output registry', () => {
      const id = '16.' + subs;
      const main = getSetup(id);
      expect(main.id).toBe(id);
      expect(main.numChannels).toBe(16);
      expect(main.lfe).toBe(subs);
      expect(getOutputLayout(id)?.channelCount).toBe(16 + subs);
    });
  }
});

describe('2D motion – lines, loops, programmable descriptions', () => {
  const plan = (kind: SpatialMotionPlan['kind'], loop = false): SpatialMotionPlan => ({
    kind, sideM: 4, radiusFraction: 0.8, durationSec: 4, loop,
  });

  it('all available presets return only X and Y within the square', () => {
    for (const preset of SPATIAL_MOTION_OPTIONS) {
      for (let n = 0; n <= 48; n++) {
        const p = positionAtSpatialTime(plan(preset.value, true), n * 0.25);
        expect(Object.keys(p).sort()).toEqual(['x', 'y']);
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(2);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('clockwise orbit moves right first, counterclockwise moves left first', () => {
    expect(positionAtSpatialTime(plan('orbit-clockwise'), 1).x).toBeGreaterThan(0);
    expect(positionAtSpatialTime(plan('orbit-counterclockwise'), 1).x).toBeLessThan(0);
  });

  it('straight looping paths reverse at the endpoint rather than jumping across the room', () => {
    const trajectory = plan('left-to-right', true);
    const before = positionAtSpatialTime(trajectory, 3.999);
    const after = positionAtSpatialTime(trajectory, 4.001);
    expect(Math.abs(before.x - after.x)).toBeLessThan(0.01);
    expect(positionAtSpatialTime(trajectory, 0).x).toBeCloseTo(-1.6);
    expect(positionAtSpatialTime(trajectory, 4).x).toBeCloseTo(1.6);
    expect(positionAtSpatialTime(trajectory, 8).x).toBeCloseTo(-1.6);
  });

  it('parses explicit German 2D effects with duration and loop, never executes arbitrary text', () => {
    expect(parseSpatialMotionText('links rechts links rechts')).toMatchObject({
      ok: true, kind: 'left-right-left-right',
    });
    expect(parseSpatialMotionText('im Kreis linksherum 6 Sekunden loop')).toEqual({
      ok: true, kind: 'orbit-counterclockwise', durationSec: 6, loop: true,
    });
    expect(parseSpatialMotionText('von vorne nach hinten')).toMatchObject({
      ok: true, kind: 'front-to-back',
    });
    expect(parseSpatialMotionText('Unerklärliche Bewegung nach Jupiter')).toMatchObject({
      ok: false,
    });
  });
});
