/**
 * generate-golden-wav.ts – Golden-Master-WAV für A/B/X-Audio-Regression
 * =====================================================================
 * Rendert eine deterministische 1-s-Referenz (Stereo-Sinus-Mix) durch die
 * Referenz-Worklet-Kette (it-synth → eq3 → mastering) und schreibt sie als
 * 16-bit/48-kHz-WAV nach tests/fixtures/audio/golden-1s.wav.
 *
 * Aufruf:  npx tsx scripts/generate-golden-wav.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerReferenceWorkletSpecs, REFERENCE_WORKLET_IDS } from '../src/core/audio/workletSpecs';
import { workletGraphRuntime } from '../src/core/audio/WorkletGraphRuntime';
import { OfflineBounceEngine } from '../src/audio/bounce/OfflineBounceEngine';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../tests/fixtures/audio');
const outFile = path.join(outDir, 'golden-1s.wav');

const SR = 48000;
const DURATION = 1.0;
const frames = Math.round(SR * DURATION);

function buildSource(): Float32Array[] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 0.8);
    left[i] = Math.sin(2 * Math.PI * 440 * t) * 0.4 * env;
    right[i] = Math.sin(2 * Math.PI * 554.37 * t) * 0.4 * env;
  }
  return [left, right];
}

function writeWav16(file: string, channels: Float32Array[], sampleRate: number): void {
  const numCh = channels.length;
  const numFrames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const dataSize = numFrames * numCh * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // PCM chunk size
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(numCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numCh * bytesPerSample, 28);
  buf.writeUInt16LE(numCh * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const v = Math.max(-1, Math.min(1, channels[ch][i]));
      buf.writeInt16LE(Math.round(v * 32767), off);
      off += 2;
    }
  }
  writeFileSync(file, buf);
}

registerReferenceWorkletSpecs(workletGraphRuntime);
const engine = new OfflineBounceEngine(SR);
const result = engine.bounce(buildSource(), [...REFERENCE_WORKLET_IDS], { tailSeconds: 0 });

mkdirSync(outDir, { recursive: true });
writeWav16(outFile, result.output, SR);

const hash = createHash('sha256').update(Buffer.from(result.output[0].buffer, result.output[0].byteOffset, result.output[0].byteLength)).digest('hex');
console.log('Golden-Master geschrieben:', outFile);
console.log('Frames:', frames, 'SampleRate:', SR);
console.log('SHA-256 (L-Kanal Float32):', hash);
