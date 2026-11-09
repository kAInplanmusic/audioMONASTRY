import { describe, expect, it } from 'vitest';
import { assertSquareRoom, calculateSquarePerimeterSpeakers, proposeSquareCalibration } from '../src/core/spatial/v2/squareRoom';
import { parseSpatialMotionText, positionAtSpatialTime, type SpatialMotionPlan } from '../src/core/spatial/v2/motion';

describe('spatialMONK exact square room / 2D speaker geometry', () => {
  it.each([12, 16, 18, 24] as const)('%i satellites remain exactly on a 4x4m perimeter', (count) => {
    const speakers = calculateSquarePerimeterSpeakers(4, count);
    expect(speakers).toHaveLength(count);
    for (const speaker of speakers) {
      const { x, y } = speaker.positionM;
      expect(Math.max(Math.abs(x), Math.abs(y))).toBeCloseTo(2, 5);
      expect(speaker.outputChannel).toBe(null);
      expect(speaker.role).toBe('satellite');
    }
  });
  it('16 satellites in 4m square = 1m per wall step; 2 subs separate from satellite ring', () => {
    const sp = calculateSquarePerimeterSpeakers(4, 16, 2);
    expect(sp).toHaveLength(18);
    expect(sp[0].positionM).toEqual({ x: -2, y: 2 });
    expect(sp[1].positionM).toEqual({ x: -1, y: 2 });
    expect(sp[4].positionM).toEqual({ x: 2, y: 2 });
    expect(sp[8].positionM).toEqual({ x: 2, y: -2 });
    expect(sp[12].positionM).toEqual({ x: -2, y: -2 });
    expect(sp[16].role).toBe('subwoofer');
    expect(sp[17].role).toBe('subwoofer');
  });
  it('calibration proposals match real metre distances and virtual-circle delay at wall centre', () => {
    const data = proposeSquareCalibration(calculateSquarePerimeterSpeakers(4, 16));
    const corner = data[0]; const wallCentre = data[2];
    expect(corner.listenerDistanceM).toBeCloseTo(Math.sqrt(8), 6);
    expect(corner.relativeDelayMs).toBeCloseTo(0, 6);
    expect(wallCentre.listenerDistanceM).toBeCloseTo(2, 6);
    expect(wallCentre.relativeDelayMs).toBeCloseTo((Math.sqrt(8) - 2) / 343.2 * 1000, 6);
    expect(wallCentre.relativeTrimDb).toBeCloseTo(-3.0103, 3);
  });
  it('disallows rectangular rooms in the square-only planner', () => {
    expect(() => assertSquareRoom({ widthM: 4, depthM: 5 })).toThrow('square');
    expect(assertSquareRoom({ widthM: 4, depthM: 4 })).toBe(4);
  });
});

const setup = (kind: SpatialMotionPlan['kind']): SpatialMotionPlan => ({
  kind, sideM: 4, radiusFraction: 1, durationSec: 4, loop: false,
});
describe('spatialMONK exact X/Y spatial motion paths', () => {
  it('moves in 2D, with circle only as an EFFECT (not a 3D UI)', () => {
    const plan = setup('orbit-clockwise');
    expect(positionAtSpatialTime(plan, 0)).toEqual({ x: 0, y: 2 });
    expect(positionAtSpatialTime(plan, 1).x).toBeCloseTo(2);
    expect(positionAtSpatialTime(plan, 2).y).toBeCloseTo(-2);
  });
  it('moves linearly front/back and left/right', () => {
    expect(positionAtSpatialTime(setup('front-to-back'), 0)).toEqual({ x: 0, y: 2 });
    expect(positionAtSpatialTime(setup('front-to-back'), 4)).toEqual({ x: 0, y: -2 });
    expect(positionAtSpatialTime(setup('left-to-right'), 0)).toEqual({ x: -2, y: 0 });
    expect(positionAtSpatialTime(setup('left-to-right'), 4)).toEqual({ x: 2, y: 0 });
  });
  it('performs left-right-left-right as four traversals', () => {
    const p = setup('left-right-left-right');
    expect(positionAtSpatialTime(p, 0).x).toBeCloseTo(-2);
    expect(positionAtSpatialTime(p, 1).x).toBeCloseTo(2);
    expect(positionAtSpatialTime(p, 2).x).toBeCloseTo(-2);
    expect(positionAtSpatialTime(p, 3).x).toBeCloseTo(2);
    expect(positionAtSpatialTime(p, 4).x).toBeCloseTo(-2);
  });
  it('supports deterministic loop and square-wall cycle', () => {
    const p = setup('square-perimeter');
    expect(positionAtSpatialTime(p, 0)).toEqual({ x: -2, y: 2 });
    expect(positionAtSpatialTime(p, 1)).toEqual({ x: 2, y: 2 });
    expect(positionAtSpatialTime({ ...p, loop: true }, 5)).toEqual({ x: 2, y: 2 });
  });
  it('parses bounded natural language and refuses unknown action', () => {
    expect(parseSpatialMotionText('Links Rechts Links Rechts, 6 Sekunden')).toMatchObject({ ok: true, kind: 'left-right-left-right', durationSec: 6 });
    expect(parseSpatialMotionText('Im Kreis linksherum, 2.5 Sekunden in Loop')).toMatchObject({ ok: true, kind: 'orbit-counterclockwise', durationSec: 2.5, loop: true });
    expect(parseSpatialMotionText('Bewege die Quelle diagonal in 3 s')).toMatchObject({ ok: true, kind: 'diagonal', durationSec: 3 });
    expect(parseSpatialMotionText('fliegen und explodieren')).toMatchObject({ ok: false });
  });
});
