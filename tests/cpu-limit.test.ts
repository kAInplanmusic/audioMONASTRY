import { describe, it, expect } from 'vitest';
import { BackendMainProcessors } from '../server/backendMainProcessors';

const SR = 96000;
const FRAMES = SR; // 1 second blocks

function generateSource(id: string, frames: number, amp = 0.3): Map<string, Float32Array> {
  const interleaved = new Float32Array(frames * 2);
  const freq = 440 * Math.pow(1.3, parseInt(id));
  for (let f = 0; f < frames; f++) {
    const phase = (2 * Math.PI * freq * f) / SR;
    const v = Math.sin(phase) * amp;
    interleaved[2 * f] = v;
    interleaved[2 * f + 1] = v;
  }
  return new Map([['source-' + id, interleaved]]);
}

function measureCpu(numSources: number, rounds = 10): { timeMs: number; cpuCores: number } {
  const processor = new BackendMainProcessors(SR);
  
  // Warmup - initialize
  const warmup = generateSource('0', FRAMES);
  processor.process(warmup, {
    master: { active: true, parameters: { gain: 1, limiter: { active: true, ceilingDb: -1, truePeak: true }, bands: Array(12).fill(0) }, epoch: 1 }
  });
  
  // Measure
  let totalMs = 0;
  for (let r = 0; r < rounds; r++) {
    const sources = new Map<string, Float32Array>();
    for (let i = 0; i < numSources; i++) {
      const src = generateSource(String(i), FRAMES, 0.25);
      src.forEach((data, id) => sources.set(id, data));
    }
    
    const start = process.hrtime.bigint();
    processor.process(sources, {
      master: { active: true, parameters: { 
        gain: 1, 
        limiter: { active: true, ceilingDb: -1, truePeak: true },
        bands: Array(12).fill(0) 
      }, epoch: 1 }
    });
    const elapsedNs = process.hrtime.bigint() - start;
    totalMs += Number(elapsedNs) / 1e6;
  }
  
  const avgMsPerBlock = totalMs / rounds;
  // CORRECT CPU calculation: ms / 1000 = fraction of one core
  const cpuCores = avgMsPerBlock / 1000;
  
  return { timeMs: avgMsPerBlock, cpuCores };
}

describe('R20 Phase 2 – CPU Measurement & Oversampling Optimization', () => {
  it('measures CPU for 4 sources', () => {
    const { cpuCores } = measureCpu(4, 10);
    console.log('4 sources CPU: ' + cpuCores.toFixed(4) + ' vCPU');
    
    // Must be less than 2.0 vCPU
    expect(cpuCores).toBeLessThan(2.0);
  });

  it('measures CPU for 6 sources', () => {
    const { cpuCores } = measureCpu(6, 10);
    console.log('6 sources CPU: ' + cpuCores.toFixed(4) + ' vCPU');
    
    // Must be less than 3.8 vCPU threshold
    expect(cpuCores).toBeLessThan(3.8);
    
    if (cpuCores > 3.8) {
      console.log('BLOCKER: exceeds 3.8 vCPU threshold!');
      console.log('Recommendation: Use 2x Oversampling instead of 4x for production.');
    } else {
      console.log('OK: within 3.8 vCPU threshold.');
    }
  });
});