/**
 * dropMONK – Analyser-Tap (Adapter um einen echten AnalyserNode) · DSP-P2-003
 * ==========================================================================
 * Brückt einen vorhandenen WebAudio-`AnalyserNode` auf den Feature-Vertrag
 * `SpectrumFrame` (Magnituden + sampleRate + Bin-Breite + Skala), den der
 * Spektral-Kern (spectrum.ts) und `MixerBridge` verstehen.
 *
 * Bewusst KEIN Plattform-Zugriff: der Knoten wird hereingereicht (die App-Schicht
 * erzeugt ihn über `audioEngine.createVisualAnalyser()`), hier werden nur Bins
 * gelesen. Fehlt ein Knoten oder ein passender Puffer, ist das Ergebnis `null`
 * – dropMONK fällt dann auf den Kanal-Pegel-Weg zurück, statt Stille als
 * Spektrum zu verkaufen.
 *
 * `AnalyserLike` ist ein struktureller Typ: Tests können einen Fake übergeben,
 * ohne dass ein AudioContext nötig ist (headless, deterministisch).
 */

import type { SpectrumFrame } from './spectrum';

/** Der Ausschnitt eines AnalyserNode, den dropMONK wirklich nutzt. */
export interface AnalyserLike {
  /** Zahl der Frequenz-Bins (fftSize / 2). */
  readonly frequencyBinCount: number;
  /** FFT-Größe (Zeitbereich); Bin-Breite = sampleRate / fftSize. */
  readonly fftSize: number;
  /** Kontext mit Abtastrate (bei Fakes optional). */
  readonly context?: { readonly sampleRate?: number } | null;
  /** Schreibt die aktuellen Frequenzwerte in dBFS (typisch -100..0). */
  getFloatFrequencyData(target: Float32Array): void;
}

/** Abtastrate, wenn der Kontext keine liefert (Standard im DAW-Pfad). */
export const DEFAULT_SAMPLE_RATE = 48000;

/** Legt den (wiederverwendbaren) Ziel-Puffer für einen Analyser an. */
export function createFrameBuffer(analyser: AnalyserLike): Float32Array {
  const bins = Number.isFinite(analyser?.frequencyBinCount) ? analyser.frequencyBinCount : 0;
  const buffer = new Float32Array(Math.max(0, bins));
  // Vorbelegung mit -Infinity = Stille in der dB-Skala. Wichtig: ein Puffer aus
  // Nullen wäre in dB NICHT still, sondern Vollaussteuerung (0 dBFS) – ein nicht
  // gefüllter Frame würde sonst als „brüllend laut" gelesen.
  buffer.fill(Number.NEGATIVE_INFINITY);
  return buffer;
}

/**
 * Liest einen FFT-Frame aus dem Analyser in `buffer` (Hot Path: keine
 * Allokation, `buffer` muss `frequencyBinCount` Elemente haben).
 *
 * Rückgabe `null`, wenn kein nutzbarer Analyser/Puffer vorliegt – der Aufrufer
 * bleibt dann beim Pegel-Weg.
 */
export function readAnalyserFrame(
  analyser: AnalyserLike | null | undefined,
  buffer: Float32Array | null | undefined,
  fallbackSampleRate: number = DEFAULT_SAMPLE_RATE,
): SpectrumFrame | null {
  if (!analyser || !buffer) return null;
  if (typeof analyser.getFloatFrequencyData !== 'function') return null;

  const bins = analyser.frequencyBinCount;
  if (!Number.isFinite(bins) || bins <= 0 || buffer.length !== bins) return null;

  try {
    analyser.getFloatFrequencyData(buffer);
  } catch {
    return null;
  }

  const contextRate = analyser.context?.sampleRate;
  const sampleRate =
    Number.isFinite(contextRate) && (contextRate as number) > 0
      ? (contextRate as number)
      : Number.isFinite(fallbackSampleRate) && fallbackSampleRate > 0
        ? fallbackSampleRate
        : DEFAULT_SAMPLE_RATE;

  const fftSize = Number.isFinite(analyser.fftSize) && analyser.fftSize > 0 ? analyser.fftSize : bins * 2;

  return {
    magnitudes: buffer,
    sampleRate,
    binWidthHz: sampleRate / fftSize,
    scale: 'db',
  };
}
