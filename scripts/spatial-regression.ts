/**
 * spatialMONK Audio-Regression (WhitePaper Abschnitt 11)
 * =======================================================
 * Deterministischer Offline-Render des spatial-processors in Node:
 *   - Impuls bei Azimut -90/0/+90, Qualität low + medium
 *   - prüft ILD-Dominanz und ITD (rechtes Ohr führt bei +90°)
 *   - schreibt Vergleichs-WAVs nach test-results/spatial-regression/
 *
 * Aufruf: npx tsx scripts/spatial-regression.ts
 * Exit: 0 = ok, 1 = Regression
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Worklet-Global bereitstellen, BEVOR das Modul geladen wird.
(globalThis as any).sampleRate = 48000;

const SAMPLE_RATE = 48000;
const BLOCK = 128;
const BLOCKS = 8; // 1024 Samples (~21 ms)
const TOTAL = BLOCK * BLOCKS;

function writeWav(file: string, left: Float32Array, right: Float32Array): void {
  const numSamples = left.length;
  const buffer = Buffer.alloc(44 + numSamples * 4);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 4, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(2, 22); // stereo
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 4, 40);
  for (let i = 0; i < numSamples; i++) {
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), 44 + i * 4);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), 46 + i * 4);
  }
  writeFileSync(file, buffer);
}

function argmaxAbs(a: Float32Array): number {
  let best = 0;
  let bestIdx = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]);
    if (v > best) { best = v; bestIdx = i; }
  }
  return bestIdx;
}

function peak(a: Float32Array): number {
  let best = 0;
  for (let i = 0; i < a.length; i++) best = Math.max(best, Math.abs(a[i]));
  return best;
}

async function main(): Promise<void> {
  const { SpatialProcessor } = await import('../src/audio/worklets/spatialProcessor.ts');

  const outDir = path.resolve(process.cwd(), 'test-results/spatial-regression');
  mkdirSync(outDir, { recursive: true });

  const scenarios: { az: number; quality: 'low' | 'medium' }[] = [
    { az: -90, quality: 'low' },
    { az: 0, quality: 'low' },
    { az: 90, quality: 'low' },
    { az: -90, quality: 'medium' },
    { az: 90, quality: 'medium' },
  ];

  for (const sc of scenarios) {
    const p = new SpatialProcessor();
    p.port.postMessage({ cmd: 'setGlobal', quality: sc.quality, listenerRot: 0, masterGain: 1 });
    p.port.postMessage({ cmd: 'addSource', id: 1, name: 'imp', az: sc.az, el: 0, dist: 1, gain: 1 });

    const outL = new Float32Array(TOTAL);
    const outR = new Float32Array(TOTAL);
    for (let b = 0; b < BLOCKS; b++) {
      const inL = new Float32Array(BLOCK);
      if (b === 0) inL[0] = 1; // Impuls
      const inputs: Float32Array[][] = [[inL]];
      const blockL = new Float32Array(BLOCK);
      const blockR = new Float32Array(BLOCK);
      const outputs: Float32Array[][] = [[blockL, blockR]];
      p.process(inputs, outputs);
      outL.set(blockL, b * BLOCK);
      outR.set(blockR, b * BLOCK);
    }

    const lPeak = peak(outL);
    const rPeak = peak(outR);
    const lIdx = argmaxAbs(outL);
    const rIdx = argmaxAbs(outR);

    if (sc.az === -90) {
      assert.ok(lPeak > rPeak * 2, `az -90 (${sc.quality}): links muss dominieren (L=${lPeak.toFixed(3)}, R=${rPeak.toFixed(3)})`);
    }
    if (sc.az === 0) {
      const ratio = Math.max(lPeak, rPeak) / Math.max(1e-6, Math.min(lPeak, rPeak));
      assert.ok(ratio < 1.25, `az 0 (${sc.quality}): Mitte muss ausgeglichen sein (Ratio=${ratio.toFixed(3)})`);
    }
    if (sc.az === 90) {
      assert.ok(rPeak > lPeak * 2, `az +90 (${sc.quality}): rechts muss dominieren (L=${lPeak.toFixed(3)}, R=${rPeak.toFixed(3)})`);
      if (sc.quality === 'low') {
        const itd = lIdx - rIdx;
        assert.ok(itd >= 25 && itd <= 35, `az +90 low: ITD rechts führt ~30 Samples (ist=${itd})`);
      }
    }

    writeWav(path.join(outDir, `az${sc.az}_${sc.quality}.wav`), outL, outR);
    console.log(`ok az=${sc.az} quality=${sc.quality} L=${lPeak.toFixed(3)} R=${rPeak.toFixed(3)} Lidx=${lIdx} Ridx=${rIdx}`);
  }

  console.log(`\nspatialMONK Regression ok – WAVs in ${outDir}`);
}

main().catch((e) => {
  console.error('spatialMONK Regression FAILED:', e);
  process.exit(1);
});
