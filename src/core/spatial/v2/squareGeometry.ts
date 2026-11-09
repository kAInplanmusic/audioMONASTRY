/**
 * spatialMONK — exact TWO-AXIS, ear-height square room geometry.
 * Coordinates: room centre (0,0); +X right; +Y front; units METRES.
 * A square canvas is not a circular room. Automatic placements are a
 * configurable starting geometry and never evidence of installed hardware.
 */
import { createPerimeterSpeakers, type SpatialSpeakerV2, type SpatialVec2 } from './model';

export interface SquareRoomLayoutV2 {
  sideM: number;
  satelliteCount: number;
  subwooferCount: number;
  listenerM: SpatialVec2;
  speakers: SpatialSpeakerV2[];
  /** Distance between adjacent satellite positions along the room perimeter. */
  perimeterPitchM: number;
}

const finite = (n: number): boolean => Number.isFinite(n);
export function assertSquareSide(sideM: number): void {
  if (!finite(sideM) || sideM < 2 || sideM > 60) {
    throw new RangeError('Square room side must be within 2..60 metres');
  }
}

export function metersToSquareNormalized(point: SpatialVec2, sideM: number): SpatialVec2 {
  assertSquareSide(sideM);
  const half = sideM / 2;
  return { x: Math.max(-1, Math.min(1, point.x / half)), y: Math.max(-1, Math.min(1, point.y / half)) };
}

export function squareNormalizedToMeters(point: SpatialVec2, sideM: number): SpatialVec2 {
  assertSquareSide(sideM);
  if (!finite(point.x) || !finite(point.y)) throw new RangeError('Invalid 2D position');
  const half = sideM / 2;
  return { x: Math.max(-1, Math.min(1, point.x)) * half,
    y: Math.max(-1, Math.min(1, point.y)) * half };
}

/**
 * Perimeter-mounted satellites at equal arc-length. The 2ch case is special:
 * both stereo speakers are on the front wall rather than opposite corners.
 * Manual speaker positions override defaults while retaining stable channel IDs.
 * Subwoofers are separate physical outputs, NOT directional VBAP speakers.
 */
export function createSquareRoomLayout(
  sideM: number,
  satelliteCount: number,
  subwooferCount = 0,
  manualPositions: Readonly<Record<string, SpatialVec2>> = {},
): SquareRoomLayoutV2 {
  assertSquareSide(sideM);
  if (!Number.isSafeInteger(satelliteCount) || satelliteCount < 2 || satelliteCount > 24) {
    throw new RangeError('Satellite count must be 2..24');
  }
  if (!Number.isSafeInteger(subwooferCount) || subwooferCount < 0 || subwooferCount > 2) {
    throw new RangeError('Subwoofer count must be 0..2');
  }
  const half = sideM / 2;
  const defaults = satelliteCount === 2
    ? [
        { id: 'sat-01', role: 'satellite' as const, positionM: { x: -sideM / 4, y: half }, outputChannel: null, trimDb: 0, delayMs: 0, polarity: 1 as const },
        { id: 'sat-02', role: 'satellite' as const, positionM: { x: sideM / 4, y: half }, outputChannel: null, trimDb: 0, delayMs: 0, polarity: 1 as const },
      ]
    : createPerimeterSpeakers({ widthM: sideM, depthM: sideM }, satelliteCount);
  const subwoofers: SpatialSpeakerV2[] = Array.from({ length: subwooferCount }, (_, i) => ({
    id: 'sub-' + (i + 1), role: 'subwoofer', outputChannel: null,
    positionM: { x: subwooferCount === 1 ? 0 : (i === 0 ? -sideM / 4 : sideM / 4), y: half },
    trimDb: 0, delayMs: 0, polarity: 1,
  }));
  const speakers = [...defaults, ...subwoofers].map((sp) => {
    const override = manualPositions[sp.id];
    if (override === undefined) return sp;
    if (!finite(override.x) || !finite(override.y) ||
        Math.abs(override.x) > half || Math.abs(override.y) > half) {
      throw new RangeError('Speaker coordinate outside square: ' + sp.id);
    }
    return { ...sp, positionM: { ...override } };
  });
  return {
    sideM, satelliteCount, subwooferCount, listenerM: { x: 0, y: 0 },
    speakers,
    perimeterPitchM: (4 * sideM) / satelliteCount,
  };
}

export function squareSpeakerDistanceM(speaker: SpatialSpeakerV2, listenerM: SpatialVec2 = { x: 0, y: 0 }): number {
  return Math.hypot(speaker.positionM.x - listenerM.x, speaker.positionM.y - listenerM.y);
}
