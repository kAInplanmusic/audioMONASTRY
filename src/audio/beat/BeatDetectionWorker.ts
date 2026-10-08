/**
 * audioMONASTRY · BeatDetectionWorker (AUDIO-P0-BEATMATCH-B1)
 * ==========================================================
 * Offline-Beat-Analyse in einem Web Worker – NIE im Audio-Thread.
 *
 * Kette:
 *   1. STFT mit Hann-Fenster (Default 2048 / Hop 512) → Betragsspektrum über
 *      eine radix-2-FFT (O(N log N)). Die frühere "FFT" war eine O(N²)-DFT pro
 *      Frame und damit für Musiklängen unbrauchbar langsam.
 *   2. Spectral Flux, Frame-zu-Frame, halbwellen-gleichgerichtet → Onset-Flux.
 *   3. Onset-Envelope: lokale Mittelwert-Subtraktion (adaptive Schwelle) + Norm.
 *   4. Tempo: Autokorrelation der Onset-Envelope, 60–200 BPM, mit Oktav-Präferenz
 *      85–175 BPM (halbe/doppelte Lags werden verworfen).
 *   5. Beat-Phase: der Offset mit maximaler Onset-Energie am Beat-Raster wird
 *      `firstBeatOffsetSamples`.
 *
 * Datenmodell: `beatGridModel.ts` (versioniert, serialisierbar).
 */
import type { BeatGridInfo } from './beatGridModel';

export type { BeatGridInfo, BeatMarker } from './beatGridModel';

/** Iterative radix-2-FFT (in-place) + Betragsspektrum. `n` muss 2^k sein. */
export function fftMagnitudes(re: Float64Array, im: Float64Array, n: number, mag: Float64Array): void {
  // Bit-Reversal-Permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const vr = re[b] * cwr - im[b] * cwi;
        const vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
}

/** Spectral-Flux (Onset-Detektion) über die STFT. */
export function computeSpectralFlux(
  buffer: Float32Array,
  sampleRate: number,
  frameSize = 2048,
  hopSize = 512,
): Float32Array {
  void sampleRate;
  if (buffer.length < frameSize || frameSize < 2 || hopSize < 1) return new Float32Array(0);
  const n = frameSize;
  const numFrames = Math.floor((buffer.length - n) / hopSize) + 1;
  const flux = new Float32Array(numFrames);

  // Hann-Fenster (periodisch)
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mag = new Float64Array(n / 2 + 1);
  const prev = new Float64Array(n / 2 + 1);

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    for (let i = 0; i < n; i++) {
      re[i] = buffer[start + i] * win[i];
      im[i] = 0;
    }
    fftMagnitudes(re, im, n, mag);
    let fluxVal = 0;
    if (f > 0) {
      for (let k = 1; k <= n / 2; k++) {
        const d = mag[k] - prev[k];
        if (d > 0) fluxVal += d;
      }
    }
    flux[f] = fluxVal;
    prev.set(mag);
  }
  return flux;
}

/** Onset-Envelope: lokale Mittelwert-Subtraktion (adaptive Schwelle) + Normierung. */
export function onsetEnvelope(flux: Float32Array, windowFrames = 12): Float32Array {
  const out = new Float32Array(flux.length);
  if (flux.length === 0) return out;
  let maxVal = 1e-9;
  for (let i = 0; i < flux.length; i++) {
    let sum = 0;
    let count = 0;
    const lo = i - windowFrames < 0 ? 0 : i - windowFrames;
    const hi = i + windowFrames > flux.length - 1 ? flux.length - 1 : i + windowFrames;
    for (let j = lo; j <= hi; j++) { sum += flux[j]; count++; }
    const local = sum / (count > 0 ? count : 1);
    const v = flux[i] - local;
    out[i] = v > 0 ? v : 0;
    if (out[i] > maxVal) maxVal = out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= maxVal;
  return out;
}

/**
 * Tempo per Autokorrelation der Onset-Envelope. `frameRate` = Frames pro Sekunde
 * (sampleRate / hopSize). Oktav-Präferenz: nur wenn im 85–175-BPM-Fenster kein
 * Kandidat liegt, wird der globale Bestwert genommen.
 */
export function detectTempo(
  onset: Float32Array,
  frameRate: number,
  minBpm = 60,
  maxBpm = 200,
  prefMin = 85,
  prefMax = 175,
): { bpm: number; confidence: number } {
  if (onset.length < 4 || frameRate <= 0) return { bpm: 0, confidence: 0 };
  const minLag = Math.max(1, Math.floor((60 / maxBpm) * frameRate));
  const maxLag = Math.min(onset.length - 1, Math.ceil((60 / minBpm) * frameRate));
  if (maxLag <= minLag) return { bpm: 0, confidence: 0 };

  let bestLag = -1;
  let bestScore = 0;
  let bestInRange = -1;
  let bestInRangeScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < onset.length; i++) sum += onset[i] * onset[i + lag];
    sum /= onset.length - lag;
    if (sum > bestScore) { bestScore = sum; bestLag = lag; }
    const bpm = (60 * frameRate) / lag;
    if (bpm >= prefMin && bpm <= prefMax && sum > bestInRangeScore) {
      bestInRangeScore = sum;
      bestInRange = lag;
    }
  }
  if (bestLag < 0) return { bpm: 0, confidence: 0 };
  const lag = bestInRange > 0 ? bestInRange : bestLag;

  let norm = 0;
  for (let i = 0; i < onset.length; i++) norm += onset[i] * onset[i];
  norm /= onset.length;
  const score = bestInRange > 0 ? bestInRangeScore : bestScore;
  const confidence = norm > 1e-9 ? Math.min(1, score / norm) : 0;
  return { bpm: (60 * frameRate) / lag, confidence };
}

/**
 * Beat-Phase: der Offset (in Frames), an dem die Summe der Onset-Energie über
 * das Beat-Raster maximal ist. Liefert den ersten Beat in Samples (mod Beat-
 * Länge). Die STFT-Zentrierung (`+ frameSize/2`) wird herausgerechnet, damit der
 * Wert die echte Beat-Position im Signal trifft.
 */
export function beatPhase(
  onset: Float32Array,
  bpm: number,
  frameRate: number,
  hopSize: number,
  sampleRate: number,
  frameSize = 2048,
  beatsPerBar = 4,
): { firstBeatOffsetSamples: number; beatsPerBar: number; confidence: number } {
  if (bpm <= 0 || onset.length === 0 || hopSize < 1 || frameRate <= 0) {
    return { firstBeatOffsetSamples: 0, beatsPerBar, confidence: 0 };
  }
  const periodFrames = (60 / bpm) * frameRate; // Frames pro Beat
  const periodSamples = (60 / bpm) * sampleRate;
  if (periodFrames < 1 || periodSamples < 1) {
    return { firstBeatOffsetSamples: 0, beatsPerBar, confidence: 0 };
  }
  const scanned = Math.max(1, Math.round(periodFrames));

  let bestOffset = 0;
  let bestScore = -1;
  let bestHits = 0;
  for (let offset = 0; offset < scanned; offset++) {
    let sum = 0;
    let hits = 0;
    for (let k = 0; ; k++) {
      const idx = Math.round(offset + k * periodFrames);
      if (idx >= onset.length) break;
      sum += onset[idx];
      hits++;
    }
    if (sum > bestScore) { bestScore = sum; bestOffset = offset; bestHits = hits; }
  }
  const confidence = bestHits > 0 ? Math.min(1, bestScore / bestHits) : 0;
  // Fensterzentrierung zurückrechnen und in [0, Beat-Länge) falten.
  const beatSample = bestOffset * hopSize + frameSize / 2;
  const wrapped = ((beatSample % periodSamples) + periodSamples) % periodSamples;
  return { firstBeatOffsetSamples: Math.round(wrapped), beatsPerBar, confidence };
}

/** Analyse eines Puffers → Beat-Grid (Kern, ohne Worker-Globals – testbar). */
export function analyzeBeatGrid(
  buffer: Float32Array,
  sampleRate: number,
  frameSize = 2048,
  hopSize = 512,
): BeatGridInfo {
  const flux = computeSpectralFlux(buffer, sampleRate, frameSize, hopSize);
  const onset = onsetEnvelope(flux);
  const frameRate = sampleRate / hopSize;
  const tempo = detectTempo(onset, frameRate);
  // Phase nur auf den ersten 4 s schätzen – so akkumuliert ein kleiner
  // BPM-Fehler nicht über die ganze Datei und der Offset bleibt stabil.
  const limit = Math.min(onset.length, Math.round(4 * frameRate));
  const phase = beatPhase(onset.subarray(0, limit), tempo.bpm, frameRate, hopSize, sampleRate, frameSize, 4);
  return {
    version: 1,
    sampleRate,
    bpm: tempo.bpm,
    firstBeatOffsetSamples: phase.firstBeatOffsetSamples,
    beatsPerBar: phase.beatsPerBar,
    confidence: Math.min(tempo.confidence, 1) * Math.min(phase.confidence, 1),
  };
}

// --- Worker-Verdrahtung (nur im Worker-Scope) --------------------------------
const workerScope = typeof self !== 'undefined'
  ? (self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void })
  : null;

if (workerScope) {
  workerScope.onmessage = (event: MessageEvent) => {
    const data = event.data as {
      type?: string; buffer?: Float32Array; sampleRate?: number; frameSize?: number; hopSize?: number;
    } | undefined;
    if (data?.type !== 'analyze' || !(data.buffer instanceof Float32Array)) return;
    const grid = analyzeBeatGrid(data.buffer, data.sampleRate || 48000, data.frameSize || 2048, data.hopSize || 512);
    workerScope.postMessage({ type: 'result', beatGrid: grid });
  };
}
