/**
 * spatialMONK horizontal 2D motion presets and safe text-to-preset hints.
 * A motion moves a single source in an XY SQUARE at fixed ear height.
 * The circular mode refers only to SOURCE MOVEMENT, never to room geometry.
 * DSP automation scheduling/transport sync belongs to the audio graph.
 */
export type SpatialMotionId =
  | 'still' | 'circle-clockwise' | 'circle-counterclockwise'
  | 'left-right' | 'front-back' | 'diagonal-up' | 'diagonal-down'
  | 'square-clockwise' | 'square-counterclockwise'
  | 'figure-eight' | 'front-arc' | 'back-arc'
  | 'side-to-side-fast';

export interface SpatialMotionPresetV2 {
  id: SpatialMotionId;
  label: string;
  description: string;
}
export interface MotionXY { x: number; y: number }

export const SPATIAL_MOTION_PRESETS: readonly SpatialMotionPresetV2[] = [
  { id: 'still', label: 'Position halten', description: 'Keine Bewegung' },
  { id: 'circle-clockwise', label: 'Kreis ↻', description: 'Im Uhrzeigersinn auf Ohrhöhe' },
  { id: 'circle-counterclockwise', label: 'Kreis ↺', description: 'Gegen den Uhrzeigersinn' },
  { id: 'left-right', label: 'Links ↔ Rechts', description: 'Links–rechts–links–rechts' },
  { id: 'front-back', label: 'Vorne ↕ Hinten', description: 'Vorne–hinten–vorne' },
  { id: 'diagonal-up', label: 'Diagonal ↗', description: 'Von hinten links nach vorne rechts und zurück' },
  { id: 'diagonal-down', label: 'Diagonal ↘', description: 'Von vorne links nach hinten rechts und zurück' },
  { id: 'square-clockwise', label: 'Quadrat ↻', description: 'Vier Raumseiten im Uhrzeigersinn abfahren' },
  { id: 'square-counterclockwise', label: 'Quadrat ↺', description: 'Vier Raumseiten gegen den Uhrzeigersinn' },
  { id: 'figure-eight', label: 'Acht ∞', description: 'Horizontale Acht im Raum' },
  { id: 'front-arc', label: 'Frontbogen', description: 'Bewegung im vorderen Halbraum' },
  { id: 'back-arc', label: 'Rückbogen', description: 'Bewegung im hinteren Halbraum' },
  { id: 'side-to-side-fast', label: 'Pingpong L/R', description: 'Schneller Wechsel links–rechts' },
] as const;

const TAU = Math.PI * 2;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const positiveMod1 = (n: number) => ((n % 1) + 1) % 1;
const triangle = (t: number) => 1 - 4 * Math.abs(positiveMod1(t) - 0.5);
const scaled = (x: number, y: number, radius: number): MotionXY => ({ x: x * radius, y: y * radius });

export function motionPointAt(
  id: SpatialMotionId, phase: number, radius = 0.82,
): MotionXY {
  if (!Number.isFinite(phase) || !Number.isFinite(radius)) throw new RangeError('Invalid motion parameters');
  const t = positiveMod1(phase);
  const r = clamp01(radius);
  const sin = (a: number) => Math.sin(a);
  const cos = (a: number) => Math.cos(a);
  switch (id) {
    case 'still': return { x: 0, y: 0 };
    case 'circle-clockwise': return scaled(sin(TAU * t), cos(TAU * t), r);
    case 'circle-counterclockwise': return scaled(-sin(TAU * t), cos(TAU * t), r);
    case 'left-right': return scaled(triangle(t), 0, r);
    case 'side-to-side-fast': return scaled(triangle(positiveMod1(2 * t)), 0, r);
    case 'front-back': return scaled(0, -triangle(t), r);
    case 'diagonal-up': return scaled(triangle(t), triangle(t), r);
    case 'diagonal-down': return scaled(triangle(t), -triangle(t), r);
    case 'figure-eight': return scaled(sin(TAU * t), 0.5 * sin(2 * TAU * t), r);
    case 'front-arc': return scaled(-cos(Math.PI * t), Math.sin(Math.PI * t), r);
    case 'back-arc': return scaled(-cos(Math.PI * t), -Math.sin(Math.PI * t), r);
    case 'square-clockwise':
    case 'square-counterclockwise': {
      // Continuous path at four square corners, no jumps at seam.
      const corners: MotionXY[] = [
        { x: -1, y: 1 }, { x: 1, y: 1 },
        { x: 1, y: -1 }, { x: -1, y: -1 },
      ];
      const pos = (id === 'square-clockwise' ? t : positiveMod1(1 - t)) * 4;
      const i = Math.floor(pos), f = pos - i;
      const a = corners[i], b = corners[(i + 1) % 4];
      return scaled(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, r);
    }
  }
  throw new Error('Unknown motion preset: ' + id);
}

export function sampleMotionPath(
  id: SpatialMotionId, points = 65, radius = 0.82,
): MotionXY[] {
  if (!Number.isSafeInteger(points) || points < 2 || points > 1025) {
    throw new RangeError('Invalid motion sample count');
  }
  return Array.from({ length: points }, (_, i) => motionPointAt(id, i / (points - 1), radius));
}

/**
 * Lightweight deterministic prompt resolver, no LLM guessing. Unknown text
 * returns null. Never execute arbitrary text or allow source routing commands.
 */
export function interpretSpatialMotionText(text: string): SpatialMotionId | null {
  const q = text.trim().toLocaleLowerCase('de-DE');
  if (!q || q.length > 500) return null;
  const circle = /kreis|circle|rundherum|rotier|umrund/.test(q);
  const reverse = /gegen.*uhrzeiger|gegen.*clock|counter.?clock|linksherum|anticlock/.test(q);
  if (circle) return reverse ? 'circle-counterclockwise' : 'circle-clockwise';
  if (/acht|figure.?eight|unendlich/.test(q)) return 'figure-eight';
  if (/quadrat|rechteck|vier.?eck|square/.test(q)) {
    return reverse ? 'square-counterclockwise' : 'square-clockwise';
  }
  if (/diagonal|schr[aä]g/.test(q)) {
    return /oben|vorne rechts|hinten links/.test(q) ? 'diagonal-up' : 'diagonal-down';
  }
  if (/bogen|arc/.test(q)) return /hinten|rück|back/.test(q) ? 'back-arc' : 'front-arc';
  if (/ping.?pong|hin.?und.?her.*schnell/.test(q)) return 'side-to-side-fast';
  if (/(links|left)/.test(q) && /(rechts|right)/.test(q)) return 'left-right';
  if (/(vorne|front)/.test(q) && /(hinten|back)/.test(q)) return 'front-back';
  if (/still|halten|station[aä]r|center|mitte/.test(q)) return 'still';
  return null;
}
