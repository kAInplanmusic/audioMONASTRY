/**
 * audioMONASTRY – lokale Audio-Analyse (kein API, kein extra Workflow).
 * ---------------------------------------------------------------
 * Analysiert ein Lied direkt im Browser via Web Audio API (Offline-Deckodierung):
 *   - BPM (Onset-Detection + Autokorrelation)
 *   - Key (Chromagramm + Krumhansl-Schmuckler-Template → Camelot)
 *   - Energy / Danceability / Loudness / Spectral Flux
 *
 * Ergebnis wird pro URL gecacht (in-Memory und optional localStorage).
 */

import { createAnalysisAudioContext } from './audioContextFactory';
import { storageGet, storageSet } from './storage';

export interface TrackAnalysis {
  bpm: number;
  key: string;          // z.B. "Am"
  camelot: string;      // z.B. "8A"
  energy: number;       // 0..1
  danceability: number; // 0..1
  loudness: number;     // RMS-ähnlich in dB
  duration: number;     // Sekunden
  flux: number;         // Spectral Flux (0..~1)
}

// Krumhansl-Schmuckler Major/Minor Key-Profile (12 Halbtöne, C als Basis).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Camelot-Wheel pro Halbton (Index 0 = C) für Major/Minor.
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['8A', '3A', '10A', '5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A'];

let analysisCache: Record<string, TrackAnalysis> = {};

/** Lädt und dekodiert eine Audio-Datei (offline, ohne Wiedergabe). */
async function fetchAudioBuffer(url: string): Promise<AudioBuffer | null> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Audio nicht lesbar: ${url}`);
  const ab = await res.arrayBuffer();
  // Wir nutzen einen normalen AudioContext nur zum Offline-Dekodieren
  // (decodeAudioData) und schliessen ihn danach – keine sichtbare Wiedergabe.
  const dec = createAnalysisAudioContext();
  if (!dec) return null;
  try {
    const buf = await decode(dec, ab);
    dec.close?.();
    return buf;
  } catch (e) {
    dec.close?.();
    throw e;
  }
}

function decode(ctx: AudioContext, ab: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const fn = ctx.decodeAudioData.bind(ctx);
    fn(ab, resolve, reject);
  });
}

/** Reduziert mono, alle Kanäle gemittelt. */
function toMonoMono(buffer: AudioBuffer, maxSec = 180): { ch: Float32Array; sr: number } {
  const sr = buffer.sampleRate;
  let len = buffer.length;
  const maxLen = Math.floor(sr * maxSec);
  if (len > maxLen) len = maxLen;
  const ch = new Float32Array(len);
  const n = Math.min(buffer.numberOfChannels, 8);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < n; c++) s += buffer.getChannelData(c)[i] || 0;
    ch[i] = s / n;
  }
  return { ch, sr };
}

/** Spectral-Flux an allen Windows via FFT (vereinfacht: Frame-Energie-Differenz). */
function computeFlux(ch: Float32Array, sr: number): Float32Array {
  const hop = Math.floor(sr / 43); // ~43 fps Fenster-Rate
  const win = 1024;
  const flux: number[] = [];
  let prev = 0;
  for (let i = 0; i + win < ch.length; i += hop) {
    let e = 0;
    for (let k = 0; k < win; k++) {
      const v = ch[i + k];
      e += v * v;
    }
    e = Math.sqrt(e / win);
    flux.push(Math.max(0, e - prev));
    prev = e;
  }
  return new Float32Array(flux);
}

/** BPM via Onset-Autokorrelation des Spectral-Flux. */
function detectBpm(ch: Float32Array, sr: number): number { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
  const flux = computeFlux(ch, sr);
  if (flux.length < 8) return 128;
  // Onset-Schwelle: Mittelwert + 1,2x Std.
  let m = 0;
  let n = 0;
  for (let i = 0; i < flux.length; i++) { m += flux[i]; n++; }
  m = m / (n || 1);
  let s2 = 0;
  for (let i = 0; i < flux.length; i++) s2 += (flux[i] - m) * (flux[i] - m);
  const sd = Math.sqrt(s2 / (n || 1));
  const thresh = m + 1.4 * sd;

  const onsets: number[] = [];
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] > thresh && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]) onsets.push(i);
  }
  const fps = 43.0; // Fenster pro Sekunde
  if (onsets.length < 3) return 128;

  // Intervalle zwischen Onsets → BPM-Kandidat (meist Klick-Periode *2 oder /2).
  const intervalCandidates: number[] = [];
  for (let a = 0; a < onsets.length; a++) {
    for (let b = a + 1; b < onsets.length; b++) {
      const sec = (onsets[b] - onsets[a]) / fps;
      if (sec < 0.15) continue;
      const rpm = 60 / sec;
      // Näherung auf plausible Range 60..240, harmonisch reduzieren (×2 / ÷2).
      let v = rpm;
      while (v > 240) v /= 2;
      while (v < 60) v *= 2;
      intervalCandidates.push(v);
    }
  }
  if (intervalCandidates.length === 0) return 128;
  // Histogramm über die Kandidaten (mit leichtem Binning).
  const w = 2.0; // BPM-Bin
  const hist = new Map<number, number>();
  for (const v of intervalCandidates) {
    const bin = Math.round(v / w) * w;
    hist.set(bin, (hist.get(bin) || 0) + 1);
  }
  let best = 128, bestCount = 0;
  hist.forEach((cnt, bpm) => {
    if (cnt > bestCount) { bestCount = cnt; best = bpm; }
  });
  return Math.round(best);
}

/** Key/Camelot via Chromagramm + Krumhansl-Schmuckler-Korrelation. */
function detectKey(ch: Float32Array, sr: number): { key: string; camelot: string } { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
  // Chroma über das gesamte Signal, mithilfe einer festen FFT-Größe.
  // Wir nehmen einen zentralen Ausschnitt (erste ~45 s reichen typischerweise)
  // und bilden ein gewöhnliches FFT-Magnituden-Spektrum.
  const fftSize = 8192;
  const binHz = sr / fftSize;
  const A4 = 440;
  const chroma = new Array(12).fill(0);

  const half = Math.floor(ch.length / 2);
  const center = Math.floor(half / fftSize) * fftSize;
  // Zwei FFTs: erster + dritter Frequenzabschnitt des ersten ~Million-Samples.
  for (const offset of [0, Math.floor(half / 3)]) {
    if (offset + fftSize > ch.length) continue;
    // Einfache DFT (Goertzel-förmig) nur für die 12 Notenfrequenz-Klassen
    // im hörbaren Bereich – sehr lesbar und gut deterministisch.
    for (let pc = 0; pc < 12; pc++) {
      let e = 0;
      for (let oct = 36; oct <= 72; oct += 12) {
        const midi = oct + pc;
        const f = A4 * Math.pow(2, (midi - 69) / 12);
        if (f >= sr / 2) continue;
        let r = 0, im = 0;
        const ph = (-2 * Math.PI * f) / sr;
        for (let t = 0; t < fftSize; t += 2) {
          const idx = offset + t;
          if (idx >= ch.length) break;
          const v = ch[idx];
          r += v * Math.cos(ph * t);
          im += v * Math.sin(ph * t);
        }
        e += r * r + im * im;
      }
      chroma[pc] += e;
    }
  }
  const sum = chroma.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < 12; i++) chroma[i] = chroma[i] / sum;

  let bestScore = -1, bestIdx = 0, bestIsMinor = false;
  for (let shift = 0; shift < 12; shift++) {
    let sMaj = 0, sMin = 0;
    for (let i = 0; i < 12; i++) {
      const idx = (shift + i) % 12;
      sMaj += chroma[idx] * MAJOR_PROFILE[i];
      sMin += chroma[idx] * MINOR_PROFILE[i];
    }
    if (sMaj > bestScore) { bestScore = sMaj; bestIdx = shift; bestIsMinor = false; }
    if (sMin > bestScore) { bestScore = sMin; bestIdx = shift; bestIsMinor = true; }
  }
  const key = KEY_NAMES[bestIdx] + (bestIsMinor ? 'm' : '');
  const camelot = bestIsMinor ? CAMELOT_MINOR[bestIdx] : CAMELOT_MAJOR[bestIdx];
  return { key, camelot };
}

/** Energie/Danceability/Loudness aus dem Signal. */
function energyAndDance(ch: Float32Array, sr: number): { energy: number; danceability: number; loudness: number; flux: number } {
  let sumSq = 0, n = 0;
  for (let i = 0; i < ch.length; i += 4) { sumSq += ch[i] * ch[i]; n++; }
  const rms = Math.sqrt(sumSq / (n || 1));
  const loudness = 20 * Math.log10(Math.max(rms, 1e-7));

  // Energy: RMS relativ zu Voll-Skala (0..1, weich skaliert).
  const energy = Math.max(0, Math.min(1, (rms * 4) / (0.9) ));

  // Spectral Flux als Danceability-Proxy (schnelle Transienten → tanzen).
  const fluxArr = computeFlux(ch, sr);
  let fluxSum = 0, fn = 0;
  for (let i = 0; i < fluxArr.length; i++) { fluxSum += fluxArr[i]; fn++; }
  const flux = fluxArr.length ? fluxSum / fluxArr.length : 0;
  const danceability = Math.max(0, Math.min(1, Math.min(1, flux * 40)));

  return { energy, danceability, loudness, flux };
}

/** Haupt-Analysefunktion: gibt - für eine url - BPM/Key/etc (offline). */
export async function analyzeMusic(url: string): Promise<TrackAnalysis | null> {
  if (analysisCache[url]) return analysisCache[url];
  try {
    const buf = await fetchAudioBuffer(url);
    if (!buf) return null;
    const { ch, sr } = toMonoMono(buf);
    const bpm = detectBpm(ch, sr);
    const { key, camelot } = detectKey(ch, sr);
    const { energy, danceability, loudness, flux } = energyAndDance(ch, sr);
    const analysis: TrackAnalysis = {
      bpm, key, camelot,
      energy, danceability,
      loudness,
      duration: buf.duration,
      flux,
    };
    analysisCache[url] = analysis;
    try { storageSet('am_analysis', JSON.stringify(analysisCache)); } catch { /* ok */ }
    return analysis;
  } catch (err) {
    console.warn('Audio-Analyse fehlgeschlagen:', url, err);
    return null;
  }
}

/** Holt ein gecachtes Analyse-Ergebnis (ohne Neuberechnung). */
export function getCachedAnalysis(url: string): TrackAnalysis | null {
  return analysisCache[url] ?? null;
}

// Beim Start: Cache aus dem Storage laden.
try {
  const raw = storageGet('am_analysis');
  if (raw) analysisCache = { ...JSON.parse(raw) };
} catch { /* ignore */ }
