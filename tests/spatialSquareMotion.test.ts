import { describe, it, expect } from 'vitest';
import {
  createSquareRoomLayout, metersToSquareNormalized,
  squareNormalizedToMeters, squareSpeakerDistanceM,
} from '../src/core/spatial/v2/squareGeometry';
import {
  SPATIAL_MOTION_PRESETS, interpretSpatialMotionText,
  motionPointAt, sampleMotionPath,
} from '../src/core/spatial/v2/motionPatterns';

describe('Square XY room and exact speaker coordinates', () => {
  for (const count of [2, 4, 8, 12, 16, 18, 24]) {
    it('places ' + count + ' ear-level satellites inside the 4 x 4 m square', () => {
      const layout = createSquareRoomLayout(4, count, 2);
      expect(layout.speakers).toHaveLength(count + 2);
      expect(layout.perimeterPitchM).toBeCloseTo(16 / count);
      for (const speaker of layout.speakers) {
        expect(Math.abs(speaker.positionM.x)).toBeLessThanOrEqual(2);
        expect(Math.abs(speaker.positionM.y)).toBeLessThanOrEqual(2);
        expect(squareSpeakerDistanceM(speaker)).toBeGreaterThanOrEqual(0);
        expect(speaker.outputChannel).toBeNull();
      }
      expect(layout.speakers.slice(-2).every((s) => s.role === 'subwoofer')).toBe(true);
    });
  }

  it('puts both stereo satellites on the FRONT wall', () => {
    const s = createSquareRoomLayout(4, 2).speakers;
    expect(s.map((v) => v.positionM)).toEqual([{ x: -1, y: 2 }, { x: 1, y: 2 }]);
  });

  it('computes exact 16-LS reference coordinates at 1-m perimeter spacing', () => {
    const room = createSquareRoomLayout(4, 16);
    expect(room.speakers[0].positionM).toEqual({ x: -2, y: 2 });
    expect(room.speakers[2].positionM).toEqual({ x: 0, y: 2 });
    expect(room.speakers[4].positionM).toEqual({ x: 2, y: 2 });
    expect(room.speakers[8].positionM).toEqual({ x: 2, y: -2 });
    expect(room.speakers[12].positionM).toEqual({ x: -2, y: -2 });
  });

  it('keeps physical coordinates separate from the square UI normalized space', () => {
    expect(squareNormalizedToMeters({ x: 1, y: -0.5 }, 4)).toEqual({ x: 2, y: -1 });
    expect(metersToSquareNormalized({ x: 2, y: -1 }, 4)).toEqual({ x: 1, y: -0.5 });
  });

  it('accepts manual speaker coordinates but refuses outside-square edits', () => {
    expect(createSquareRoomLayout(4, 16, 0, { 'sat-01': { x: -1, y: 1 } }).speakers[0].positionM)
      .toEqual({ x: -1, y: 1 });
    expect(() => createSquareRoomLayout(4, 16, 0, { 'sat-01': { x: 4, y: 1 } })).toThrow();
    expect(() => createSquareRoomLayout(4, 0)).toThrow();
    expect(() => createSquareRoomLayout(4, 25)).toThrow();
    expect(() => createSquareRoomLayout(0, 16)).toThrow();
  });
});

describe('XY motion presets and descriptive text', () => {
  it('keeps all 13 patterns inside the square (NO height coordinate)', () => {
    for (const p of SPATIAL_MOTION_PRESETS) {
      const points = sampleMotionPath(p.id, 129);
      expect(points).toHaveLength(129);
      for (const pos of points) {
        expect(Object.keys(pos)).toEqual(['x', 'y']);
        expect(Math.abs(pos.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(pos.y)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('supports clockwise circles and straightforward front/back, left/right', () => {
    expect(motionPointAt('circle-clockwise', 0).y).toBeGreaterThan(0);
    expect(motionPointAt('circle-clockwise', 0.25).x).toBeGreaterThan(0);
    expect(motionPointAt('circle-counterclockwise', 0.25).x).toBeLessThan(0);
    expect(motionPointAt('left-right', 0).x).toBeLessThan(0);
    expect(motionPointAt('left-right', 0.5).x).toBeGreaterThan(0);
    expect(motionPointAt('front-back', 0).y).toBeGreaterThan(0);
    expect(motionPointAt('front-back', 0.5).y).toBeLessThan(0);
  });

  it('resolves common German descriptions but refuses unknown text', () => {
    expect(interpretSpatialMotionText('links rechts links rechts')).toBe('left-right');
    expect(interpretSpatialMotionText('im Kreis gegen den Uhrzeigersinn')).toBe('circle-counterclockwise');
    expect(interpretSpatialMotionText('von vorne nach hinten')).toBe('front-back');
    expect(interpretSpatialMotionText('einmal als Acht laufen')).toBe('figure-eight');
    expect(interpretSpatialMotionText('die Engel fliegen nach Saturn')).toBeNull();
  });
});
