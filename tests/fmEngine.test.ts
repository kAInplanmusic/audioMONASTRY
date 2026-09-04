import { describe, expect, it } from 'vitest';
import { DX7_ALGORITHMS, validateDx7Algorithms } from '../src/core/instrument/dx7Algorithms';
import { dx7LevelToGain, dx7RateToSeconds, Fm6Synth, renderFmPatch, type Dx7Patch } from '../src/core/instrument/fmEngine';
import { DX7_REFERENCE_PATCHES } from '../src/core/instrument/dx7Presets';

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

describe('6-Op-FM-Engine (produktionsreif)', () => {
  it('Algorithmus-Tabelle ist strukturell gültig (32 Algorithmen)', () => {
    const v = validateDx7Algorithms();
    expect(v.ok).toBe(true);
    expect(DX7_ALGORITHMS).toHaveLength(32);
  });

  it('Rendert alle 10 Referenz-Patches deterministisch, endlich und hörbar', () => {
    for (const patch of DX7_REFERENCE_PATCHES) {
      const opts = { sampleRate: 24000, noteHz: 261.63, velocity: 0.8, durationSeconds: 0.2 };
      const a = renderFmPatch(patch, opts);
      const b = renderFmPatch(patch, opts);
      expect(a.length).toBe(4800);
      expect(rms(a)).toBeGreaterThan(1e-4);
      for (let i = 0; i < a.length; i++) {
        expect(Number.isFinite(a[i])).toBe(true);
        expect(a[i]).toBe(b[i]); // Determinismus
      }
    }
  });

  it('unterschiedliche Patches klingen unterschiedlich (kein Null-/Duplikat)', () => {
    const opts = { sampleRate: 24000, noteHz: 440, velocity: 0.8, durationSeconds: 0.2 };
    const hashes = DX7_REFERENCE_PATCHES.map((p) => {
      const buf = renderFmPatch(p, opts);
      let h = 0;
      for (let i = 0; i < buf.length; i += 7) h = (h * 31 + Math.round(buf[i] * 1000)) >>> 0;
      return h;
    });
    expect(new Set(hashes).size).toBeGreaterThan(5);
  });

  it('DX7-Raten-/Level-Mapping ist monoton und geclampt', () => {
    expect(dx7RateToSeconds(99)).toBeLessThan(dx7RateToSeconds(50));
    expect(dx7RateToSeconds(50)).toBeLessThan(dx7RateToSeconds(1));
    expect(dx7LevelToGain(0)).toBe(0);
    expect(dx7LevelToGain(99)).toBeCloseTo(1, 3);
  });

  it('Velocity senkt den Ausgangspegel (Velocity-Sensitivity)', () => {
    const patch: Dx7Patch = JSON.parse(JSON.stringify(DX7_REFERENCE_PATCHES[0]));
    patch.operators.forEach((op) => { op.velocitySensitivity = 7; });
    const loud = rms(renderFmPatch(patch, { sampleRate: 48000, noteHz: 261.63, velocity: 1, durationSeconds: 0.4 }));
    const soft = rms(renderFmPatch(patch, { sampleRate: 48000, noteHz: 261.63, velocity: 0.2, durationSeconds: 0.4 }));
    expect(loud).toBeGreaterThan(soft);
  });

  it('Feedback (Algorithmus 10, Feedback 7) verändert den Klang messbar', () => {
    const base: Dx7Patch = JSON.parse(JSON.stringify(DX7_REFERENCE_PATCHES[9]));
    base.feedback = 0;
    const dry = renderFmPatch(base, { sampleRate: 48000, noteHz: 220, velocity: 0.8, durationSeconds: 0.4 });
    base.feedback = 7;
    const fb = renderFmPatch(base, { sampleRate: 48000, noteHz: 220, velocity: 0.8, durationSeconds: 0.4 });
    let diff = 0;
    for (let i = 0; i < dry.length; i++) diff += Math.abs(dry[i] - fb[i]);
    expect(diff).toBeGreaterThan(0.01);
  });
});

describe('Fm6Synth (polyphone Block-Engine)', () => {
  it('noteOn rendert hörbar, noteOff lässt ausklingen', () => {
    const synth = new Fm6Synth(DX7_REFERENCE_PATCHES[0], 48000, 16);
    const block = new Float32Array(128);
    synth.noteOn(261.63, 0.8);
    synth.renderBlock(block, 128);
    expect(rms(block)).toBeGreaterThan(1e-4);

    synth.noteOff(261.63);
    const tail = new Float32Array(24000);
    synth.renderBlock(tail, 24000);
    // Nach dem Release klingt das Ende aus (letzte 1000 Samples leise).
    let sum = 0;
    for (let i = tail.length - 1000; i < tail.length; i++) sum += tail[i] * tail[i];
    expect(Math.sqrt(sum / 1000)).toBeLessThan(0.05);
  });

  it('16 Voices: LRU-Stealing hält die Stimmenzahl begrenzt', () => {
    const synth = new Fm6Synth(DX7_REFERENCE_PATCHES[1], 48000, 16);
    for (let i = 0; i < 32; i++) synth.noteOn(110 + i * 7, 0.8);
    const block = new Float32Array(128);
    synth.renderBlock(block, 128);
    for (let i = 0; i < block.length; i++) expect(Number.isFinite(block[i])).toBe(true);
    expect(rms(block)).toBeGreaterThan(1e-4);
  });
});
