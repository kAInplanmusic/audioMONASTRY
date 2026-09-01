/**
 * audioMONASTRY · Output Abstraction
 * ==================================
 * Flexible Output-Konfiguration von Stereo bis 24.2. Renderer kennen keine
 * Interface-spezifischen Details – nur Layout-IDs und Kanalnamen.
 */
import { getOutputLayout, OUTPUT_LAYOUTS } from '../spatial/layouts';

export interface OutputConfig {
  layoutId: string;
  sampleRate: number;
  bufferSize: number;
  channels: string[];
  spatialMode: 'stereo' | 'spatial';
}

export function createOutputConfig(
  layoutId = 'stereo',
  sampleRate = 48000,
  bufferSize = 128,
  spatialMode: 'stereo' | 'spatial' = 'stereo',
): OutputConfig {
  const layout = getOutputLayout(layoutId);
  if (!layout) throw new Error(`Unbekanntes Output-Layout: ${layoutId}`);
  return { layoutId, sampleRate, bufferSize, channels: layout.channels, spatialMode };
}

export function listSupportedLayoutIds(): string[] {
  return OUTPUT_LAYOUTS.map((l) => l.id);
}

export function supports24_2(layoutId: string): boolean {
  return layoutId === '24.2';
}

// ---------------------------------------------------------------------------
// 2.1-Crossover (P2-3): Linkwitz-Riley 2. Ordnung, Sub < crossoverHz,
// L/R-Hochpass. Reine Koeffizienten-Berechnung → serverlos testbar.
// ---------------------------------------------------------------------------

export interface CrossoverCoefficients {
  sampleRate: number;
  crossoverHz: number;
  /** Biquad-Koeffizienten (b0,b1,b2,a1,a2) für den Tiefpass (Sub). */
  lowpass: [number, number, number, number, number];
  /** Biquad-Koeffizienten für den Hochpass (L/R). */
  highpass: [number, number, number, number, number];
}

export function designLinkwitzRileyCrossover(sampleRate = 48000, crossoverHz = 90): CrossoverCoefficients {
  const sr = Math.max(8000, sampleRate);
  const fc = Math.max(40, Math.min(200, crossoverHz));
  const w = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w);
  const sin = Math.sin(w);
  const alpha = sin / Math.SQRT2;

  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;

  // Tiefpass (Sub)
  const lpB0 = (1 - cos) / 2;
  const lpB1 = 1 - cos;
  const lpB2 = lpB0;
  // Hochpass (L/R)
  const hpB0 = (1 + cos) / 2;
  const hpB1 = -(1 + cos);
  const hpB2 = hpB0;

  return {
    sampleRate: sr,
    crossoverHz: fc,
    lowpass: [lpB0 / a0, lpB1 / a0, lpB2 / a0, a1 / a0, a2 / a0],
    highpass: [hpB0 / a0, hpB1 / a0, hpB2 / a0, a1 / a0, a2 / a0],
  };
}

/** Prüft, ob ein Layout einen dedizierten Sub-Kanal besitzt (… .1/.2). */
export function hasDedicatedSub(layoutId: string): boolean {
  const layout = getOutputLayout(layoutId);
  return !!layout && layout.channels.some((c) => c.startsWith('LFE'));
}
