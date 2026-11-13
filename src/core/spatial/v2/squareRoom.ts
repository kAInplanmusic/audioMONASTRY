/**
 * spatialMONK — exact square room / ear-height reference geometry.
 * No elevation, no 3D listener, no circular speaker ring required.
 *
 * This is a reference layout, NOT a measurement. User-entered verified
 * speaker coordinates override it when real room data is available.
 */
import type { SpatialRoomV2, SpatialSpeakerV2, SpatialVec2 } from './model';

export type SquareSpeakerCount = 12 | 16 | 18 | 24;
export const SQUARE_SPEAKER_COUNTS: readonly SquareSpeakerCount[] = [12, 16, 18, 24] as const;
export const SOUND_SPEED_MPS = 343.2;

export interface SquareSpeakerCalibration {
  id: string;
  positionM: SpatialVec2;
  listenerDistanceM: number;
  relativeDelayMs: number;
  relativeTrimDb: number;
}

function validSide(sideM: number): void {
  if (!Number.isFinite(sideM) || sideM < 1 || sideM > 60) {
    throw new RangeError('Quadratische Raumseite muss 1–60 m betragen');
  }
}
function validCount(count: number): asserts count is SquareSpeakerCount {
  if (!SQUARE_SPEAKER_COUNTS.includes(count as SquareSpeakerCount)) {
    throw new RangeError('Erlaubte Satellitenanzahl: 12, 16, 18 oder 24');
  }
}
/** Rundet auf `decimals` Stellen; `-0` (z. B. cos 270° ≈ -1.8e-16) wird zu `0`. */
const round = (number: number, decimals = 6): number =>
  Math.round(number * 10 ** decimals) / 10 ** decimals + 0;

/**
 * Start in the front-left corner, clockwise on the REAL SQUARE perimeter.
 * A 4m square with 16 satellites gives exact 1m perimeter spacing; 18 and
 * 24 speakers have uniform arc distance 16/18 and 16/24 metres respectively.
 * Real installations may need offsets from actual measured coordinates.
 */
export function calculateSquarePerimeterSpeakers(
  sideM: number,
  count: SquareSpeakerCount,
  subwoofers: 0 | 1 | 2 = 0,
): SpatialSpeakerV2[] {
  validSide(sideM);
  validCount(count);
  if (![0, 1, 2].includes(subwoofers)) throw new RangeError('Subwoofers must be 0, 1 or 2');
  const half = sideM / 2;
  const step = 4 * sideM / count;
  const satellites = Array.from({ length: count }, (_, i): SpatialSpeakerV2 => {
    const along = i * step;
    let x: number, y: number;
    if (along < sideM) { x = -half + along; y = half; }
    else if (along < 2 * sideM) { x = half; y = half - (along - sideM); }
    else if (along < 3 * sideM) { x = half - (along - 2 * sideM); y = -half; }
    else { x = -half; y = -half + (along - 3 * sideM); }
    return {
      id: 'sat-' + String(i + 1).padStart(2, '0'),
      role: 'satellite',
      positionM: { x: round(x), y: round(y) },
      outputChannel: null, trimDb: 0, delayMs: 0, polarity: 1,
    };
  });
  // Virtual sub positions for preview only. No automatic sub DSP or output.
  for (let i = 0; i < subwoofers; i++) {
    satellites.push({
      id: 'sub-' + (i + 1), role: 'subwoofer',
      positionM: { x: subwoofers === 1 ? 0 : (i === 0 ? -half * 0.7 : half * 0.7), y: half },
      outputChannel: null, trimDb: 0, delayMs: 0, polarity: 1,
    });
  }
  return satellites;
}

/**
 * Ray/square-wall intersection for the *actual* 360-degree mounting
 * references. Angle 0 = front (+Y), 90 = right (+X), clockwise.
 *
 * This is NOT the same as equal-distance perimeter mounting: every
 * source angle is evenly spaced, but physical neighbour distances vary.
 */
export function squareWallIntersectionAtAngle(sideM: number, azimuthDeg: number): SpatialVec2 {
  validSide(sideM);
  if (!Number.isFinite(azimuthDeg)) throw new RangeError('Invalid azimuth');
  const rad = azimuthDeg * Math.PI / 180;
  const dx = Math.sin(rad);
  const dy = Math.cos(rad);
  const maxAxis = Math.max(Math.abs(dx), Math.abs(dy));
  const scale = (sideM / 2) / maxAxis;
  return { x: round(dx * scale), y: round(dy * scale) };
}

export function calculateSquareAngularSpeakers(
  sideM: number,
  count: SquareSpeakerCount,
  subwoofers: 0 | 1 | 2 = 0,
  azimuthOffsetDeg = 0,
): SpatialSpeakerV2[] {
  validSide(sideM);
  validCount(count);
  if (![0, 1, 2].includes(subwoofers)) throw new RangeError('Invalid subwoofer count');
  if (!Number.isFinite(azimuthOffsetDeg)) throw new RangeError('Invalid angular offset');
  const satellites = Array.from({ length: count }, (_, i): SpatialSpeakerV2 => ({
    id: 'sat-' + String(i + 1).padStart(2, '0'),
    role: 'satellite',
    positionM: squareWallIntersectionAtAngle(sideM, azimuthOffsetDeg + 360 * i / count),
    outputChannel: null, trimDb: 0, delayMs: 0, polarity: 1,
  }));
  const half = sideM / 2;
  for (let i = 0; i < subwoofers; i++) {
    satellites.push({
      id: 'sub-' + (i + 1), role: 'subwoofer',
      positionM: { x: subwoofers === 1 ? 0 : (i === 0 ? -half * 0.7 : half * 0.7), y: half },
      outputChannel: null, trimDb: 0, delayMs: 0, polarity: 1,
    });
  }
  return satellites;
}

export function assertSquareRoom(room: SpatialRoomV2): number {
  if (!room || !Number.isFinite(room.widthM) || !Number.isFinite(room.depthM)) {
    throw new Error('Missing square room dimensions');
  }
  validSide(room.widthM);
  if (Math.abs(room.widthM - room.depthM) > 1e-6) {
    throw new Error('spatialMONK rooms must be square: widthM === depthM');
  }
  return room.widthM;
}

/**
 * Idealized virtual-circle correction for centred listener, satellites only:
 * farther satellites define reference time/level. Closer speakers get delay
 * and attenuation. Real-room SPL, phase, EQ and time-of-flight REQUIRE
 * acoustic measurement; never activate these values automatically.
 */
export function proposeSquareCalibration(
  speakers: readonly SpatialSpeakerV2[],
  listener: SpatialVec2 = { x: 0, y: 0 },
  soundSpeedMps = SOUND_SPEED_MPS,
): SquareSpeakerCalibration[] {
  if (!Number.isFinite(soundSpeedMps) || soundSpeedMps <= 0 ||
      !Number.isFinite(listener.x) || !Number.isFinite(listener.y)) {
    throw new RangeError('Invalid calibration speed/listener');
  }
  const satellites = speakers.filter((speaker) => speaker.role === 'satellite');
  const distances = satellites.map((sp) => Math.hypot(
    sp.positionM.x - listener.x, sp.positionM.y - listener.y,
  ));
  if (!distances.length || distances.some((d) => !Number.isFinite(d) || d <= 0)) {
    throw new Error('Invalid speaker distances');
  }
  const farthest = Math.max(...distances);
  return satellites.map((sp, i) => ({
    id: sp.id, positionM: { ...sp.positionM },
    listenerDistanceM: distances[i],
    relativeDelayMs: (farthest - distances[i]) / soundSpeedMps * 1000,
    relativeTrimDb: 20 * Math.log10(distances[i] / farthest),
  }));
}
