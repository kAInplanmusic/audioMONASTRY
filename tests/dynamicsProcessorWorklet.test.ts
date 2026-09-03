// @vitest-environment node
/**
 * Open-Source-Audio-Audit A-Klasse: funktionaler Test des dynamicsProcessor.
 * Prüft Kompressor (−20 dBFS Sinus → ~7,5 dB GR bei Ratio 4/Threshold −30),
 * Gate (schließt unterhalb Threshold nach Hold) und Dynamic EQ (senkt die
 * Resonanz nur bei Pegelüberschreitung), plus Determinismus/NaN-Sicherheit.
 */
import { beforeAll, describe, expect, it } from 'vitest';

interface DynamicsProcessorInstance {
  port: { onmessage: ((e: { data?: Record<string, unknown> }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorCtor = new () => DynamicsProcessorInstance;

let ProcessorCtor: ProcessorCtor | null = null;

beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = 48000;
  g.currentFrame = 0;
  g.currentTime = 0;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as unknown as DynamicsProcessorInstance['port']['onmessage'] };
  };
  g.registerProcessor = (_name: string, ctor: ProcessorCtor) => { ProcessorCtor = ctor; };
  await import('../src/audio/worklets/dynamicsProcessor.ts');
  expect(ProcessorCtor).not.toBeNull();
});

function create(msgs: Record<string, unknown>[] = []): DynamicsProcessorInstance {
  if (!ProcessorCtor) throw new Error('dynamicsProcessor nicht geladen');
  const p = new ProcessorCtor();
  for (const m of msgs) p.port.onmessage?.({ data: m });
  return p;
}

function sineBlock(freq: number, frames: number, amplitude: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / 48000) * amplitude;
  return out;
}

function rmsDb(buf: Float32Array, from = 0): number {
  let sum = 0;
  for (let i = from; i < buf.length; i++) sum += buf[i] * buf[i];
  return 20 * Math.log10(Math.max(Math.sqrt(sum / (buf.length - from)), 1e-12));
}

function runBlock(p: DynamicsProcessorInstance, src: Float32Array, frames: number): Float32Array {
  const output = [new Float32Array(frames)];
  expect(p.process([[src]], [output])).toBe(true);
  return output[0];
}

describe('dynamicsProcessor (Kompressor/Gate/DynEQ)', () => {
  it('Kompressor: −20 dBFS Peak (−23 dBFS RMS) Sinus → 5,5–8,5 dB Gain-Reduction (Threshold −30, Ratio 4)', () => {
    const frames = 48000;
    const src = sineBlock(440, frames, 0.1); // Peak −20 dBFS, RMS −23 dBFS
    const p = create([{ threshold: -30, ratio: 4, knee: 0, attack: 0.001, release: 0.05, makeup: 0 }]);
    const out = runBlock(p, src, frames);
    const outDb = rmsDb(out, 4800); // Einschwingzeit ausblenden
    // RMS −23 dBFS abzüglich 5,5–8,5 dB GR (Ziel 7,5 dB, mit Detektor-Ripple)
    expect(outDb).toBeGreaterThan(-31.5);
    expect(outDb).toBeLessThan(-28.5);
  });

  it('Gate schließt unterhalb Threshold (Range −80 dB) nach Hold', () => {
    const frames = 48000;
    const src = sineBlock(440, frames, 0.0003); // ≈ −70 dBFS, unter gateThreshold −60
    const p = create([{ gateEnabled: true, gateThreshold: -60, gateRange: -80, gateHold: 0.01, gateAttack: 0.001, gateRelease: 0.05 }]);
    const out = runBlock(p, src, frames);
    const outDb = rmsDb(out, 4800);
    expect(outDb).toBeLessThan(-120); // praktisch stumm
  });

  it('Gate lässt Signal oberhalb Threshold passieren', () => {
    const frames = 48000;
    const src = sineBlock(440, frames, 0.5); // RMS ≈ −9 dBFS
    const p = create([{ threshold: 0, ratio: 1, makeup: 0, gateEnabled: true, gateThreshold: -60, gateRange: -80, gateHold: 0.01 }]);
    const out = runBlock(p, src, frames);
    expect(rmsDb(out, 4800)).toBeGreaterThan(-10);
  });

  it('Dynamic EQ senkt die Resonanz nur bei Pegelüberschreitung', () => {
    const frames = 48000;
    const loud = sineBlock(1000, frames, 0.3);   // −10,5 dBFS → über dynEqThreshold −18
    const quiet = sineBlock(1000, frames, 0.01); // −40 dBFS → unter Threshold

    const pLoud = create([{ dynEqEnabled: true, dynEqFreq: 1000, dynEqGain: 6, dynEqQ: 1, dynEqThreshold: -18 }]);
    const loudOut = runBlock(pLoud, loud, frames);

    const pQuiet = create([{ dynEqEnabled: true, dynEqFreq: 1000, dynEqGain: 6, dynEqQ: 1, dynEqThreshold: -18 }]);
    const quietOut = runBlock(pQuiet, quiet, frames);

    const loudDb = rmsDb(loudOut, 4800);
    const quietDb = rmsDb(quietOut, 4800);
    // Lautes Signal wird relativ stärker reduziert als leises.
    expect(loudDb - quietDb).toBeLessThan(-10.5 - -40 - 3); // mind. ~3 dB zusätzliche Reduktion
  });

  it('Determinismus + NaN/Inf-Sicherheit', () => {
    const frames = 8192;
    const src = new Float32Array(frames);
    for (let i = 0; i < frames; i++) src[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.4;
    src[100] = NaN;
    src[200] = Infinity;

    const cfg = [{ threshold: -20, ratio: 3, knee: 4, gateEnabled: true, gateThreshold: -50, gateRange: -60, dynEqEnabled: true, dynEqFreq: 220, dynEqGain: 4, dynEqQ: 0.8, dynEqThreshold: -16 }];
    const a = runBlock(create(cfg), src, frames);
    const b = runBlock(create(cfg), src, frames);
    for (let i = 0; i < frames; i++) {
      expect(a[i]).toBe(b[i]);
      expect(Number.isFinite(a[i])).toBe(true);
    }
  });
});
