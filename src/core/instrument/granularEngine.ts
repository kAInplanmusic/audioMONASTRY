/**
 * audioMONASTRY · Granular-Engine (Actuate-Referenz, eigener Algorithmus)
 * ========================================================================
 * Deterministischer Grain-Scheduler für Offline-Render/Preview:
 *   * grainSize (Samples), density (Grains/s), position (0..1), positionJitter
 *   * pitch (Ratio), pitchJitter, direction (±1), window (Hann), freeze
 *   * `spray` wird bei Mono-Render ignoriert (Stereo-Panning erfolgt im
 *     Worklet/Live-Pfad über zwei Grain-Ströme).
 *
 * Kein Fremdcode. Alle Allokationen in `createGrainSchedule()`; die
 * Render-Schleife ist NaN/Inf-sicher und reproduzierbar (Golden-Test-tauglich).
 */

export interface GranularParams {
  grainSizeSamples: number;
  densityPerSec: number;
  position: number;        // 0..1 Abspielposition im Source
  positionJitter: number;  // 0..1
  pitch: number;           // Ratio (0.25..4)
  pitchJitter: number;     // 0..1
  direction: 1 | -1;
  freeze: boolean;
}

export interface GrainEvent {
  startFrame: number;
  sourcePos: number;
  length: number;
  pitch: number;
  direction: 1 | -1;
}

const TAU = 2 * Math.PI;

/** Deterministische Grain-Liste für eine Render-Dauer. */
export function createGrainSchedule(
  sourceLength: number,
  params: GranularParams,
  durationSeconds: number,
  sampleRate: number,
  seed = 12345,
): GrainEvent[] {
  const sr = Math.max(8000, sampleRate);
  const totalFrames = Math.max(1, Math.round(durationSeconds * sr));
  const grainSize = Math.max(16, Math.min(8192, Math.round(params.grainSizeSamples)));
  const density = Math.max(1, Math.min(500, params.densityPerSec));
  const stepFrames = Math.max(grainSize / 2, Math.round(sr / density));
  const events: GrainEvent[] = [];

  let rnd = seed >>> 0;
  const rand = (): number => {
    rnd = (rnd * 1664525 + 1013904223) >>> 0;
    return rnd / 2 ** 32;
  };

  const basePos = Math.max(0, Math.min(1, params.position)) * Math.max(0, sourceLength - grainSize);

  for (let frame = 0; frame < totalFrames; frame += stepFrames) {
    const jitterPos = params.freeze ? 0 : (rand() * 2 - 1) * params.positionJitter * grainSize;
    const sourcePos = Math.max(0, Math.min(sourceLength - grainSize, basePos + jitterPos));
    const pitchJitter = (rand() * 2 - 1) * params.pitchJitter;
    events.push({
      startFrame: frame,
      sourcePos: Math.floor(sourcePos),
      length: grainSize,
      pitch: Math.max(0.25, Math.min(4, params.pitch * (1 + pitchJitter))),
      direction: params.direction,
    });
  }
  return events;
}

/** Rendert eine Grain-Cloud (mono) deterministisch. */
export function renderGrainCloud(
  source: Float32Array,
  params: GranularParams,
  durationSeconds: number,
  sampleRate: number,
  seed = 12345,
): Float32Array {
  const sr = Math.max(8000, sampleRate);
  const totalFrames = Math.max(1, Math.round(durationSeconds * sr));
  const out = new Float32Array(totalFrames);
  const events = createGrainSchedule(source.length, params, durationSeconds, sr, seed);

  for (const g of events) {
    const window = (i: number): number => {
      const n = Math.max(1, g.length - 1);
      return 0.5 * (1 - Math.cos((TAU * i) / n)); // Hann
    };
    for (let i = 0; i < g.length; i++) {
      const outIdx = g.startFrame + i;
      if (outIdx >= totalFrames) break;
      const srcIdx = g.direction === 1
        ? g.sourcePos + Math.floor(i * g.pitch)
        : g.sourcePos + g.length - 1 - Math.floor(i * g.pitch);
      if (srcIdx < 0 || srcIdx >= source.length) continue;
      let v = source[srcIdx] * window(i);
      if (!Number.isFinite(v)) v = 0;
      out[outIdx] += v;
    }
  }

  // Normalisieren + NaN/Inf-Guard.
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  if (peak > 1) {
    const norm = 1 / peak;
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] * norm));
  }
  return out;
}
