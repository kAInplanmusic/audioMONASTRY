import { describe, expect, it } from 'vitest';
import {
  BANDS,
  bandEnergies,
  computeFeatures,
  detectOnset,
  rmsFromTimeDomain,
} from '../src/core/visual/featureBus';

const SAMPLE_RATE = 48000;
const FFT_SIZE = 2048;
const BINS = FFT_SIZE / 2;
const HZ_PER_BIN = SAMPLE_RATE / FFT_SIZE;

function freqInRange(lo: number, hi: number, value = 255): Uint8Array {
  const f = new Uint8Array(BINS);
  for (let i = 0; i < BINS; i += 1) {
    const hz = i * HZ_PER_BIN;
    if (hz >= lo && hz < hi) f[i] = value;
  }
  return f;
}

describe('VisualMONK – Feature-Bus', () => {
  it('trennt die Bänder korrekt', () => {
    const bass = bandEnergies(freqInRange(BANDS.bass[0], BANDS.bass[1]), SAMPLE_RATE, FFT_SIZE);
    expect(bass.bass).toBeGreaterThan(0.5);
    expect(bass.mid).toBe(0);
    expect(bass.treble).toBe(0);

    const mid = bandEnergies(freqInRange(BANDS.mid[0], BANDS.mid[1]), SAMPLE_RATE, FFT_SIZE);
    expect(mid.mid).toBeGreaterThan(0.5);
    expect(mid.bass).toBe(0);

    const treble = bandEnergies(freqInRange(BANDS.treble[0], BANDS.treble[1]), SAMPLE_RATE, FFT_SIZE);
    expect(treble.treble).toBeGreaterThan(0.5);
    expect(treble.bass).toBe(0);
  });

  it('bleibt bei leerem/ungültigem Puffer bei 0', () => {
    expect(bandEnergies(new Uint8Array(0), SAMPLE_RATE, FFT_SIZE)).toEqual({ bass: 0, mid: 0, treble: 0 });
    expect(bandEnergies(new Uint8Array(BINS), SAMPLE_RATE, 0)).toEqual({ bass: 0, mid: 0, treble: 0 });
  });

  it('rechnet RMS aus dem Zeitbereich', () => {
    expect(rmsFromTimeDomain(new Float32Array(128))).toBe(0);
    const half = new Float32Array(128).fill(0.1);
    expect(rmsFromTimeDomain(half)).toBeCloseTo(0.2, 5);
    expect(rmsFromTimeDomain(new Float32Array(128).fill(0.5))).toBe(1); // geklemmt
  });

  it('erkennt nur steigende Pegel als Onset', () => {
    expect(detectOnset(0.5, 0.2)).toBeCloseTo(0.75, 5);
    expect(detectOnset(0.2, 0.5)).toBe(0);
    expect(detectOnset(1, 0, 10)).toBe(1);
  });

  it('setzt Energie als Mittel der Bänder und klemmt alles auf 0..1', () => {
    const freq = new Uint8Array(BINS).fill(128);
    const time = new Float32Array(64).fill(0.25);
    const f = computeFeatures(freq, time, { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, prevRms: 0 });
    expect(f.bass).toBeGreaterThan(0.4);
    expect(f.energy).toBeGreaterThan(0);
    expect(f.energy).toBeLessThanOrEqual(1);
    expect(f.bpm).toBe(0);
    for (const v of [f.bass, f.mid, f.treble, f.rms, f.onset, f.energy]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(BANDS.treble[1]).toBe(16000);
  });

  // VISUAL-P1-002: BPM kommt aus dem V2-Transport (injiziert), nicht aus dem
  // Audiosignal – der Wert muss gerundet und gegen Unsinn geklemmt werden.
  it('übernimmt das Transport-Tempo und rundet es', () => {
    const freq = new Uint8Array(BINS).fill(128);
    const time = new Float32Array(64).fill(0.25);
    const f = computeFeatures(freq, time, { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, bpm: 128.4 });
    expect(f.bpm).toBe(128);
  });

  it('lässt ungültiges/gestopptes Tempo bei 0', () => {
    const freq = new Uint8Array(BINS).fill(128);
    const time = new Float32Array(64).fill(0.25);
    expect(computeFeatures(freq, time, { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, bpm: 0 }).bpm).toBe(0);
    expect(computeFeatures(freq, time, { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, bpm: -12 }).bpm).toBe(0);
    expect(computeFeatures(freq, time, { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE }).bpm).toBe(0);
    expect(computeFeatures(freq, time, { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, bpm: Number.NaN }).bpm).toBe(0);
  });
});
