import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerReferenceWorkletSpecs, REFERENCE_WORKLET_IDS, STATEFUL_REFERENCE_IDS } from '../src/core/audio/workletSpecs';
import { workletGraphRuntime } from '../src/core/audio/WorkletGraphRuntime';
import { OfflineBounceEngine } from '../src/audio/bounce/OfflineBounceEngine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_WAV = path.resolve(__dirname, 'fixtures/audio/golden-1s.wav');
const SR = 48000;
const FRAMES = 48000;

/** Baut exakt dieselbe Quelle wie scripts/generate-golden-wav.ts. */
function buildGoldenSource(): Float32Array[] {
  const left = new Float32Array(FRAMES);
  const right = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 0.8);
    left[i] = Math.sin(2 * Math.PI * 440 * t) * 0.4 * env;
    right[i] = Math.sin(2 * Math.PI * 554.37 * t) * 0.4 * env;
  }
  return [left, right];
}

/** Minimaler 16-bit-PCM-WAV-Parser (nur unser Fixture-Format). */
function readWav16(file: string): { sampleRate: number; channels: Float32Array[] } {
  const buf = readFileSync(file);
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  expect(bits).toBe(16);
  const dataSize = buf.readUInt32LE(40);
  const frames = dataSize / (channels * 2);
  const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(frames));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      out[ch][i] = buf.readInt16LE(off) / 32768;
      off += 2;
    }
  }
  return { sampleRate, channels: out };
}

function sha256(buf: Float32Array): string {
  return createHash('sha256').update(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)).digest('hex');
}

registerReferenceWorkletSpecs(workletGraphRuntime);

describe('A/B/X-Golden-Master (WAV-Fixture)', () => {
  it('A (Fixture) == B (frischer Render), bit-genau in 16-bit-PCM', () => {
    const fixture = readWav16(GOLDEN_WAV);
    expect(fixture.sampleRate).toBe(SR);

    const engine = new OfflineBounceEngine(SR);
    const render = engine.bounce(buildGoldenSource(), [...REFERENCE_WORKLET_IDS], { tailSeconds: 0 });

    expect(render.output.length).toBe(fixture.channels.length);
    for (let ch = 0; ch < fixture.channels.length; ch++) {
      const expected = fixture.channels[ch];
      const actual = render.output[ch];
      expect(actual.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        const a = Math.round(Math.max(-1, Math.min(1, actual[i])) * 32767);
        const b = Math.round(expected[i] * 32767);
        if (a !== b) {
          expect.fail(`PCM-Differenz an Sample ${i} Kanal ${ch}: ${a} vs ${b}`);
        }
      }
    }
  });

  it('X (zweiter Render) ist identisch zu B (Determinismus)', () => {
    const engine = new OfflineBounceEngine(SR);
    const a = engine.bounce(buildGoldenSource(), [...REFERENCE_WORKLET_IDS], { tailSeconds: 0 });
    const b = engine.bounce(buildGoldenSource(), [...REFERENCE_WORKLET_IDS], { tailSeconds: 0 });
    for (let ch = 0; ch < a.output.length; ch++) {
      expect(sha256(a.output[ch])).toBe(sha256(b.output[ch]));
    }
  });
});

describe('DSP-Spec-Erweiterung: state-behaftete Tail-Tests', () => {
  it('Impuls durch delay+reverb erzeugt Energie im Tail (Tail-Management greift)', () => {
    const engine = new OfflineBounceEngine(SR);
    const impulse = [new Float32Array(256)];
    impulse[0][0] = 1.0; // Dirac bei t=0

    const result = engine.bounce(impulse, [...STATEFUL_REFERENCE_IDS], { tailSeconds: 1 });
    expect(result.tailFrames).toBe(SR);

    const tail = result.output[0].subarray(256);
    let energy = 0;
    for (let i = 0; i < tail.length; i++) energy += tail[i] * tail[i];
    expect(Math.sqrt(energy / tail.length)).toBeGreaterThan(1e-4);
  });

  it('state-behaftete Kette ist nach reset() reproduzierbar (bit-identisch)', () => {
    const engine = new OfflineBounceEngine(SR);
    const source = [new Float32Array(512)];
    for (let i = 0; i < 512; i++) source[0][i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.3;

    const a = engine.bounce(source, [...STATEFUL_REFERENCE_IDS], { tailSeconds: 0.5 });
    const b = engine.bounce(source, [...STATEFUL_REFERENCE_IDS], { tailSeconds: 0.5 });
    expect(sha256(a.output[0])).toBe(sha256(b.output[0]));
  });
});

describe('P0-4 Prüfpunkt: 60 s ohne aktives Plugin → RMS ≤ -60 dBFS (Master-Kette)', () => {
  it('rendert 60 s Stille durch alle Referenz-Worklets ohne Restrauschen', () => {
    const SR48 = 48000;
    const seconds = 60;
    const silence = [new Float32Array(SR48 * seconds), new Float32Array(SR48 * seconds)];
    const engine = new OfflineBounceEngine(SR48);
    const render = engine.bounce(
      silence,
      [...REFERENCE_WORKLET_IDS, ...STATEFUL_REFERENCE_IDS],
      { tailSeconds: 0 },
    );

    expect(render.renderedFrames).toBe(SR48 * seconds);
    for (const ch of render.output) {
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      const rms = Math.sqrt(sum / ch.length);
      const dbfs = 20 * Math.log10(Math.max(rms, 1e-12));
      expect(Number.isFinite(dbfs)).toBe(true);
      expect(dbfs).toBeLessThanOrEqual(-60);
    }
  });
});
