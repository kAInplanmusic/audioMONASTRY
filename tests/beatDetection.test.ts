// @vitest-environment node
/**
 * AUDIO-P0-BEATMATCH-B1: Beat-Grid je Track
 * =========================================
 * Geprüft wird der echte Analyse-Kern des `BeatDetectionWorker` (FFT-basierte
 * Spectral-Flux-Onset-Erkennung → Autokorrelations-Tempo → Beat-Phase) sowie die
 * Bridge (Worker im Browser, neutraler Fallback in Node).
 */
import { describe, expect, it } from 'vitest';
import { analyzeBeatGrid, computeSpectralFlux, detectTempo } from '../src/audio/beat/BeatDetectionWorker';
import { BeatWorkerBridge } from '../src/audio/beat/beatWorkerBridge';

const SR = 48000;

/** Klick-Track mit gegebenem BPM/Offset (Kick-artige Impulse). */
function clickTrack(bpm: number, offsetSamples = 0, seconds = 8): Float32Array {
  const n = Math.round(SR * seconds);
  const b = new Float32Array(n);
  const period = Math.round((60 / bpm) * SR);
  for (let p = offsetSamples; p + 64 < n; p += period) {
    for (let i = 0; i < 64; i++) b[p + i] += Math.exp(-i / 8) * Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.8;
  }
  return b;
}

describe('AUDIO-P0-BEATMATCH-B1 · Beat-Erkennung (FFT/Spectral Flux)', () => {
  it('Spectral Flux ist bei Impulsen > 0 und bei Stille 0', () => {
    const flux = computeSpectralFlux(clickTrack(120), SR, 1024, 256);
    expect(flux.length).toBeGreaterThan(0);
    expect(Math.max(...flux)).toBeGreaterThan(0);
    const silent = computeSpectralFlux(new Float32Array(48000), SR, 1024, 256);
    expect(Math.max(...silent)).toBe(0);
  });

  it.each([90, 120, 140])('erkennt %i BPM auf ±2 %% genau (Klick-Track)', (bpm) => {
    const grid = analyzeBeatGrid(clickTrack(bpm), SR, 1024, 256);
    expect(Math.abs(grid.bpm - bpm) / bpm).toBeLessThan(0.02);
    expect(grid.version).toBe(1);
    expect(grid.sampleRate).toBe(SR);
    expect(grid.beatsPerBar).toBe(4);
  });

  it('Beat-Phase liegt innerhalb 20 ms zum echten Beat-Offset', () => {
    for (const [bpm, offset] of [[120, 1000], [100, 777], [128, 0]] as [number, number][]) {
      const grid = analyzeBeatGrid(clickTrack(bpm, offset), SR, 1024, 256);
      const period = (60 / bpm) * SR;
      const expected = ((offset % period) + period) % period;
      const d = Math.abs(grid.firstBeatOffsetSamples - expected);
      const wrapped = Math.min(d, period - d);
      expect(wrapped / SR).toBeLessThan(0.02); // < 20 ms
    }
  });

  it('ist deterministisch (gleicher Puffer → gleiches Grid)', () => {
    const buf = clickTrack(120, 500);
    const a = analyzeBeatGrid(buf, SR, 1024, 256);
    const b = analyzeBeatGrid(buf, SR, 1024, 256);
    expect(a).toEqual(b);
  });

  it('Stille → kein Tempo (bpm 0)', () => {
    const grid = analyzeBeatGrid(new Float32Array(SR * 2), SR, 1024, 256);
    expect(grid.bpm).toBe(0);
  });

  it('detectTempo liefert 0 bei zu kurzer Envelope', () => {
    expect(detectTempo(new Float32Array(2), 187.5).bpm).toBe(0);
  });
});

describe('AUDIO-P0-BEATMATCH-B1 · Bridge (Worker-Fallback in Node)', () => {
  it('ohne window/Worker → neutrale Schätzung (bpm 120), kein Hängen', async () => {
    const bridge = new BeatWorkerBridge();
    const grid = await bridge.analyzeBuffer(new Float32Array(SR), SR);
    expect(grid.bpm).toBe(120);
    expect(grid.beatsPerBar).toBe(4);
    expect(grid.confidence).toBe(0);
    // Der zuletzt ermittelte Wert ist abrufbar.
    expect(bridge.getGrid()).toEqual(grid);
    expect(bridge.getBpm()).toBe(120);
  });
});
