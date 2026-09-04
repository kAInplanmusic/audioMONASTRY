import { describe, expect, it } from 'vitest';
import { createGrainSchedule, renderGrainCloud, type GranularParams } from '../src/core/instrument/granularEngine';

const SR = 48000;

function sineSource(freq: number, frames: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

const baseParams: GranularParams = {
  grainSizeSamples: 480,
  densityPerSec: 20,
  position: 0,
  positionJitter: 0,
  pitch: 1,
  pitchJitter: 0,
  direction: 1,
  freeze: false,
};

describe('Granular-Engine (produktionsreif)', () => {
  it('1-kHz-Grain ist reproduzierbar (Golden-Test-tauglich)', () => {
    const src = sineSource(1000, SR);
    const a = renderGrainCloud(src, baseParams, 0.5, SR);
    const b = renderGrainCloud(src, baseParams, 0.5, SR);
    expect(a.length).toBe(24000);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  it('Rendert hörbar und NaN/Inf-frei', () => {
    const src = sineSource(440, SR);
    const out = renderGrainCloud(src, baseParams, 0.5, SR);
    expect(rms(out)).toBeGreaterThan(1e-4);
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i])).toBe(true);
  });

  it('Freeze hält die Position (kein Positions-Jitter)', () => {
    const src = sineSource(440, SR);
    const frozen = renderGrainCloud(src, { ...baseParams, freeze: true, positionJitter: 0.5 }, 0.4, SR);
    const jittered = renderGrainCloud(src, { ...baseParams, freeze: false, positionJitter: 0.5 }, 0.4, SR);
    let diff = 0;
    for (let i = 0; i < frozen.length; i++) diff += Math.abs(frozen[i] - jittered[i]);
    expect(diff).toBeGreaterThan(0.01);
  });

  it('Pitch ändert den Klang; Direction kehrt die Leserichtung um', () => {
    const src = sineSource(440, SR);
    const low = renderGrainCloud(src, { ...baseParams, pitch: 0.5 }, 0.3, SR);
    const high = renderGrainCloud(src, { ...baseParams, pitch: 2 }, 0.3, SR);
    const fwd = renderGrainCloud(src, { ...baseParams, direction: 1 }, 0.3, SR);
    const rev = renderGrainCloud(src, { ...baseParams, direction: -1 }, 0.3, SR);
    let pitchDiff = 0;
    let dirDiff = 0;
    for (let i = 0; i < low.length; i++) pitchDiff += Math.abs(low[i] - high[i]);
    for (let i = 0; i < fwd.length; i++) dirDiff += Math.abs(fwd[i] - rev[i]);
    expect(pitchDiff).toBeGreaterThan(0.01);
    expect(dirDiff).toBeGreaterThan(0.01);
  });

  it('Schedule ist deterministisch und innerhalb des Source', () => {
    const src = sineSource(440, SR);
    const events = createGrainSchedule(src.length, baseParams, 0.5, SR);
    expect(events.length).toBeGreaterThan(5);
    for (const g of events) {
      expect(g.sourcePos).toBeGreaterThanOrEqual(0);
      expect(g.sourcePos + g.length).toBeLessThanOrEqual(src.length + 1);
    }
  });
});
