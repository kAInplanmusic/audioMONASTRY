/**
 * spatialMONK 2D VBAP geometry reference (SP-P1-02).
 *
 * Pure control-plane algorithm: no physical I/O, no LFE, no filters and no
 * allocations guarantee. Compute/update gains off the audio callback, then
 * feed them into a future real-time renderer with parameter smoothing.
 */
import type { SpatialSpeakerV2, SpatialVec2 } from './model';

export interface VbapGain2D { speakerId: string; gain: number }
interface UnitSpeaker {
  id: string;
  index: number;
  angle: number;
  x: number;
  y: number;
}
const TAU = Math.PI * 2;
const EPS = 1e-9;

function angleOf(x: number, y: number): number {
  const value = Math.atan2(x, y);
  return value < 0 ? value + TAU : value;
}

function validPoint(p: SpatialVec2): boolean {
  return Number.isFinite(p?.x) && Number.isFinite(p?.y);
}

/**
 * Return constant-power gains for a point-source direction over a horizontal
 * ring with arbitrary satellite positions. Gains are in input-speaker order.
 * Any subwoofers are always 0; route bass separately through bass management.
 *
 * For unsupported/degenerate gaps (>=180 degrees) we choose a single nearest
 * speaker, never a negative or NaN gain.
 */
export function calculateVbap2dGains(
  sourceM: SpatialVec2,
  listenerM: SpatialVec2,
  speakers: readonly SpatialSpeakerV2[],
): VbapGain2D[] {
  if (!validPoint(sourceM) || !validPoint(listenerM)) throw new Error('Invalid spatial point');
  const gains = speakers.map((s) => ({ speakerId: s.id, gain: 0 }));
  const active: UnitSpeaker[] = [];
  for (let i = 0; i < speakers.length; i++) {
    const sp = speakers[i];
    if (sp.role !== 'satellite' || !validPoint(sp.positionM)) continue;
    const dx = sp.positionM.x - listenerM.x;
    const dy = sp.positionM.y - listenerM.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= EPS) continue; // coincident with listener is not a direction
    active.push({ id: sp.id, index: i, angle: angleOf(dx, dy), x: dx / dist, y: dy / dist });
  }
  if (!active.length) return gains;
  active.sort((a, b) => a.angle - b.angle || a.index - b.index);

  const sx = sourceM.x - listenerM.x;
  const sy = sourceM.y - listenerM.y;
  // At the exact listener position, pick front (0°) deterministically.
  const az = Math.hypot(sx, sy) <= EPS ? 0 : angleOf(sx, sy);
  const vx = Math.sin(az), vy = Math.cos(az);
  const nearest = () => {
    let best = active[0];
    let score = -Infinity;
    for (const sp of active) {
      const dot = vx * sp.x + vy * sp.y;
      if (dot > score) { score = dot; best = sp; }
    }
    gains[best.index].gain = 1;
    return gains;
  };
  if (active.length === 1) return nearest();

  for (let i = 0; i < active.length; i++) {
    const a = active[i], b = active[(i + 1) % active.length];
    const start = a.angle;
    const end = i === active.length - 1 ? b.angle + TAU : b.angle;
    const target = az < start ? az + TAU : az;
    if (target < start - EPS || target > end + EPS) continue;
    if (end - start >= Math.PI - EPS) return nearest();

    const det = a.x * b.y - b.x * a.y;
    if (Math.abs(det) <= EPS) return nearest();
    const gA = Math.max(0, (vx * b.y - b.x * vy) / det);
    const gB = Math.max(0, (a.x * vy - vx * a.y) / det);
    const norm = Math.hypot(gA, gB);
    if (norm <= EPS) return nearest();
    gains[a.index].gain = gA / norm;
    gains[b.index].gain = gB / norm;
    return gains;
  }
  return nearest();
}

/** Basic dry-source gain application for OFFLINE tests only (not AudioWorklet). */
export function renderMonoVbap2dBlock(
  input: Float32Array,
  gains: readonly VbapGain2D[],
): Float32Array[] {
  return gains.map(({ gain }) => {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const sample = Number.isFinite(input[i]) ? input[i] : 0;
      output[i] = sample * gain;
    }
    return output;
  });
}
