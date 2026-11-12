/**
 * spatialMONK 2D motion presets and deterministic text-to-intent adapter.
 * Positions are always measured in metres; the listener/head stays at ear level.
 *
 * UI/automation uses this code off the AudioWorklet thread. Real-time control
 * must convert these positions to timestamped parameters with PDC/smoothing.
 */
import type { SpatialVec2 } from './model';

export type SpatialMotionKind =
  | 'orbit-clockwise' | 'orbit-counterclockwise'
  | 'front-to-back' | 'back-to-front'
  | 'left-to-right' | 'right-to-left'
  | 'left-right-left-right' | 'front-back-front-back'
  | 'diagonal' | 'square-perimeter' | 'figure-eight' | 'center';

export const SPATIAL_MOTION_OPTIONS: readonly { value: SpatialMotionKind; label: string }[] = [
  { value: 'orbit-clockwise', label: 'Kreis: rechtsherum' },
  { value: 'orbit-counterclockwise', label: 'Kreis: linksherum' },
  { value: 'front-to-back', label: 'Gerade: vorne → hinten' },
  { value: 'back-to-front', label: 'Gerade: hinten → vorne' },
  { value: 'left-to-right', label: 'Gerade: links → rechts' },
  { value: 'right-to-left', label: 'Gerade: rechts → links' },
  { value: 'left-right-left-right', label: 'Links ↔ Rechts ↔ Links ↔ Rechts' },
  { value: 'front-back-front-back', label: 'Vorne ↔ Hinten ↔ Vorne ↔ Hinten' },
  { value: 'diagonal', label: 'Diagonale Ecke zu Ecke' },
  { value: 'square-perimeter', label: 'Quadratischer Raumumlauf' },
  { value: 'figure-eight', label: 'Acht (in 2D)' },
  { value: 'center', label: 'Zur Mitte' },
];

export interface SpatialMotionPlan {
  kind: SpatialMotionKind;
  sideM: number;
  radiusFraction: number; // [0,1], relative to half side
  durationSec: number;
  loop: boolean;
}

const finite = (n: number): boolean => Number.isFinite(n);
export function validateSpatialMotionPlan(plan: SpatialMotionPlan): void {
  if (!plan || !SPATIAL_MOTION_OPTIONS.some((o) => o.value === plan.kind)) {
    throw new Error('Unknown 2D motion');
  }
  if (!finite(plan.sideM) || plan.sideM < 1 || plan.sideM > 60 ||
      !finite(plan.radiusFraction) || plan.radiusFraction < 0 || plan.radiusFraction > 1 ||
      !finite(plan.durationSec) || plan.durationSec < 0.1 || plan.durationSec > 300) {
    throw new RangeError('Invalid 2D motion bounds/duration');
  }
}
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const bounce = (t: number): number => 1 - Math.abs(2 * (t % 1) - 1);
/** Endpoints included; returns x/y only, independent of speaker count. */
export function positionAtSpatialTime(plan: SpatialMotionPlan, seconds: number): SpatialVec2 {
  validateSpatialMotionPlan(plan);
  if (!finite(seconds)) throw new RangeError('Invalid automation time');
  const duration = plan.durationSec;
  // Closed loops (orbit/square/figure-eight) wrap after one cycle.
  // A one-way straight motion must PING-PONG when looped, otherwise it
  // teleports from the endpoint to the start every cycle (audible click).
  const straight = plan.kind === 'left-to-right' || plan.kind === 'right-to-left' ||
    plan.kind === 'front-to-back' || plan.kind === 'back-to-front' ||
    plan.kind === 'diagonal';
  const wrapped = ((seconds % duration) + duration) % duration / duration;
  const roundTrip = ((seconds % (2 * duration)) + 2 * duration) % (2 * duration) / duration;
  const p = !plan.loop ? Math.max(0, Math.min(1, seconds / duration))
    : straight ? (roundTrip <= 1 ? roundTrip : 2 - roundTrip) : wrapped;
  const r = (plan.sideM / 2) * plan.radiusFraction;
  switch (plan.kind) {
    case 'orbit-clockwise': return { x: r * Math.sin(p * Math.PI * 2), y: r * Math.cos(p * Math.PI * 2) };
    case 'orbit-counterclockwise': return { x: -r * Math.sin(p * Math.PI * 2), y: r * Math.cos(p * Math.PI * 2) };
    case 'left-to-right': return { x: mix(-r, r, p), y: 0 };
    case 'right-to-left': return { x: mix(r, -r, p), y: 0 };
    case 'front-to-back': return { x: 0, y: mix(r, -r, p) };
    case 'back-to-front': return { x: 0, y: mix(-r, r, p) };
    case 'left-right-left-right': return { x: mix(-r, r, bounce(p * 2)), y: 0 };
    case 'front-back-front-back': return { x: 0, y: mix(r, -r, bounce(p * 2)) };
    case 'diagonal': return { x: mix(-r, r, p), y: mix(r, -r, p) };
    case 'square-perimeter': {
      if (p < 0.25) return { x: mix(-r, r, p * 4), y: r };
      if (p < 0.5) return { x: r, y: mix(r, -r, (p - 0.25) * 4) };
      if (p < 0.75) return { x: mix(r, -r, (p - 0.5) * 4), y: -r };
      return { x: -r, y: mix(-r, r, (p - 0.75) * 4) };
    }
    case 'figure-eight': return { x: r * Math.sin(p * 2 * Math.PI), y: r * 0.5 * Math.sin(p * 4 * Math.PI) };
    case 'center': return { x: 0, y: 0 };
  }
}

export type SpatialPromptResult =
  | { ok: true; kind: SpatialMotionKind; durationSec: number; loop: boolean }
  | { ok: false; reason: string };

/**
 * Bounded, transparent German/English keyword parser; NOT generative AI.
 * No code execution, no unsafe commands, no model-call side effects.
 * Unknown instructions are returned to the user instead of guessed.
 */
export function parseSpatialMotionText(text: string): SpatialPromptResult {
  const raw = text.trim().toLowerCase();
  if (!raw || raw.length > 500) return { ok: false, reason: 'Bitte einen Text mit maximal 500 Zeichen eingeben.' };
  const matches = raw.match(/(\d+(?:[.,]\d+)?)\s*(sekunden|sekunde|sek\.?|seconds?|secs?|s)\b/u);
  const durationSec = matches ? Number(matches[1].replace(',', '.')) : 4;
  if (!finite(durationSec) || durationSec < 0.1 || durationSec > 300) {
    return { ok: false, reason: 'Dauer muss zwischen 0,1 und 300 Sekunden liegen.' };
  }
  const loop = /\b(loop|wiederhol|endlos|ständig|dauerhaft|repeat)\w*/u.test(raw);
  let kind: SpatialMotionKind | null = null;
  if (/acht|figure.?eight|figure 8/.test(raw)) kind = 'figure-eight';
  else if (/quadrat|square|perimeter|an den wänden|um die wände/.test(raw)) kind = 'square-perimeter';
  else if (/kreis|kreisend|circle|orbit|rotier/.test(raw)) {
    kind = /linksherum|gegen.?uhrzeiger|counter.?clockwise/.test(raw)
      ? 'orbit-counterclockwise' : 'orbit-clockwise';
  } else if (/diagonal|ecke.*ecke|corner/.test(raw)) kind = 'diagonal';
  else if (/links.*rechts.*links|left.*right.*left|hin.*her/.test(raw)) kind = 'left-right-left-right';
  else if (/vorne.*hinten.*vorne|front.*back.*front/.test(raw)) kind = 'front-back-front-back';
  else if (/rechts.*links|right.*left/.test(raw)) kind = 'right-to-left';
  else if (/links.*rechts|left.*right/.test(raw)) kind = 'left-to-right';
  else if (/hinten.*vorne|back.*front/.test(raw)) kind = 'back-to-front';
  else if (/vorne.*hinten|front.*back/.test(raw)) kind = 'front-to-back';
  else if (/mitte|center|zentrier/.test(raw)) kind = 'center';
  if (!kind) return { ok: false, reason: 'Bewegung nicht erkannt. Bitte Kreis, Links/Rechts, Vorne/Hinten, Diagonale, Quadrat oder Acht angeben.' };
  return { ok: true, kind, durationSec, loop };
}
