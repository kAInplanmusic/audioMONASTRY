import { describe, it, expect } from 'vitest';
import { MasteringProcessor, releaseCoefficient } from '../src/audio/worklets/masteringProcessor';

const SR = 48000;
const BLOCK = 128;

/** Erzeugt einen Block-Puffer (Stereo) mit fester Länge. */
function makeBlock(length = BLOCK): Float32Array[] {
  return [new Float32Array(length), new Float32Array(length)];
}

/**
 * Rendert `frames` Samples eines Eingangssignals blockweise durch den
 * Prozessor und liefert den Ausgang von Kanal 0.
 */
function render(proc: MasteringProcessor, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let pos = 0; pos < input.length; pos += BLOCK) {
    const len = Math.min(BLOCK, input.length - pos);
    const inBlock = makeBlock(len);
    inBlock[0].set(input.subarray(pos, pos + len));
    inBlock[1].set(input.subarray(pos, pos + len));
    const outBlock = makeBlock(len);
    proc.process([inBlock], [outBlock]);
    out.set(outBlock[0], pos);
  }
  return out;
}

describe('AM-E4-4 · Release-Kurve als segmentierte Lookup-Tabelle', () => {
  it('trifft die Referenz 1 - exp(-1/(sr·T)) auf < 0,5 % genau (5 ms … 1 s)', () => {
    for (const sr of [44100, 48000, 96000]) {
      for (let t = 0.005; t <= 1.0001; t += 0.005) {
        const reference = 1 - Math.exp(-1 / (sr * t));
        const lut = releaseCoefficient(t, sr);
        expect(Math.abs(lut - reference) / reference).toBeLessThan(0.005);
      }
    }
  });

  it('ist monoton fallend über die Release-Zeit und bleibt in (0, 1]', () => {
    let previous = releaseCoefficient(0.005, SR);
    expect(previous).toBeGreaterThan(0);
    expect(previous).toBeLessThanOrEqual(1);
    for (let t = 0.01; t <= 1.0001; t += 0.01) {
      const current = releaseCoefficient(t, SR);
      expect(current).toBeLessThan(previous);
      expect(current).toBeGreaterThan(0);
      previous = current;
    }
  });

  it('liefert für ungültige Eingaben einen definierten Wert (kein NaN)', () => {
    expect(releaseCoefficient(0, SR)).toBe(1);
    expect(releaseCoefficient(-1, SR)).toBe(1);
    expect(releaseCoefficient(Number.NaN, SR)).toBe(1);
    expect(Number.isFinite(releaseCoefficient(1000, SR))).toBe(true);
  });
});

describe('AM-E4-4 · Lookahead & True-Peak-Approximation', () => {
  it('Lookahead entspricht 5 ms (PDC-Wert des audioEngine-Monitorpfads)', () => {
    const proc = new MasteringProcessor();
    expect(proc.getLookaheadSamples()).toBe(Math.round(0.005 * SR));
  });

  it('verzögert das Signal um die Lookahead-Tiefe (Impuls-Test)', () => {
    const proc = new MasteringProcessor();
    // Kompression/Limiting neutralisieren, damit nur die Verzögerung wirkt.
    proc.port.onmessage?.({ data: { threshold: 0, ratio: 1, knee: 0, makeup: 1, ceiling: 1 } } as MessageEvent);
    const depth = proc.getLookaheadSamples();
    const input = new Float32Array(4 * BLOCK);
    input[0] = 0.5;
    const out = render(proc, input);

    let peakIndex = 0;
    for (let i = 1; i < out.length; i++) {
      if (Math.abs(out[i]) > Math.abs(out[peakIndex])) peakIndex = i;
    }
    expect(peakIndex).toBe(depth);
    expect(out[peakIndex]).toBeCloseTo(0.5, 5);
    // Vor dem Impuls ist der Ausgang still.
    for (let i = 0; i < depth; i++) expect(out[i]).toBe(0);
  });

  it('hält einen lauten Sinus unter dem Ceiling und bleibt NaN/Inf-frei', () => {
    const proc = new MasteringProcessor();
    proc.port.onmessage?.({ data: { threshold: -14, ratio: 4, knee: 6, makeup: 1, ceiling: 0.9, release: 0.05 } } as MessageEvent);
    const frames = SR / 2; // 0,5 s
    const input = new Float32Array(frames);
    for (let i = 0; i < frames; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.99;
    const out = render(proc, input);

    let maxAbs = 0;
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      maxAbs = Math.max(maxAbs, Math.abs(out[i]));
    }
    // Der Limiter darf das Ceiling nicht überschreiten (True-Peak-Reserve).
    expect(maxAbs).toBeLessThanOrEqual(0.9);
    // ... und darf das Signal nicht komplett wegregeln.
    expect(maxAbs).toBeGreaterThan(0.1);
  });

  it('Stille bleibt Stille (kein Rauschen, kein DC-Offset)', () => {
    const proc = new MasteringProcessor();
    const out = render(proc, new Float32Array(8 * BLOCK));
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
  });
});
