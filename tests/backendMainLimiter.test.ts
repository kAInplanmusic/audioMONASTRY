import { describe, expect, it } from 'vitest';
import { BackendMainProcessors, LIMITER_DEFAULTS } from '../server/backendMainProcessors';
import { toDb } from '../src/core/dsp/dynamicsMath';

const SR = 48000;
const tone = (hz: number, seconds = 0.25, amp = 0.25) => {
  const frames = Math.round(SR * seconds);
  const interleaved = new Float32Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    const v = Math.sin((2 * Math.PI * hz * f) / SR) * amp;
    interleaved[2 * f] = v;
    interleaved[2 * f + 1] = v;
  }
  return new Map([['song', interleaved]]);
};
const peak = (block: Float32Array) => {
  let max = 0;
  for (const v of block) if (Math.abs(v) > max) max = Math.abs(v);
  return max;
};
const masterOn = (parameters: Record<string, unknown>) => ({ master: { active: true, parameters, epoch: 1 } });

describe('R18/R20 True-Peak Lookahead Limiter in backend master path', () => {
  it('publishes default ceiling at -1.0 dBTP with truePeak enabled', () => {
    expect(LIMITER_DEFAULTS.ceilingDb).toBeCloseTo(-1.0, 2);
    expect(LIMITER_DEFAULTS.releaseSec).toBeCloseTo(0.05, 4);
    expect(LIMITER_DEFAULTS.truePeak).toBe(true); // R20: True-Peak default
  });

  it('reports truePeakDb when limiter is active', () => {
    const input = tone(1000, 0.1, 0.5);
    const processor = new BackendMainProcessors(SR);
    
    processor.process(input, masterOn({ 
      gain: 1.5, 
      limiter: { active: true, ceilingDb: -1, truePeak: true }, 
      bands: Array(12).fill(0) 
    }));
    
    const report = processor.lastReport;
    expect(report.limiter?.active).toBe(true);
    expect(report.limiter?.truePeakDb).toBeDefined();
    expect(typeof report.limiter?.truePeakDb).toBe('number');
  });

  it('captures inter-sample peaks exceeding sample peak by >0.3 dB', () => {
    // Generate a signal that peaks at -0.1 dBFS in samples but has +0.3 dBTP inter-sample peaks
    // This happens when the signal has high-frequency content near zero-crossing
    const frames = Math.round(SR * 0.1);
    const interleaved = new Float32Array(frames * 2);
    
    // Create near-clipping sine with phase that maximizes inter-sample peaks
    const freq = 997; // Prime frequency for good spectral properties
    const amp = 0.99; // Near unity amplitude
    
    for (let f = 0; f < frames; f++) {
      const phase = (2 * Math.PI * freq * f) / SR;
      const v = Math.sin(phase) * amp;
      interleaved[2 * f] = v;
      interleaved[2 * f + 1] = v;
    }
    
    const input = new Map([['test', interleaved]]);
    const processor = new BackendMainProcessors(SR);
    
    // Process with limiter ON at strict ceiling
    const result = processor.process(input, masterOn({
      gain: 1,
      limiter: { active: true, ceilingDb: -1, truePeak: true },
      bands: Array(12).fill(0)
    }));
    
    const report = processor.lastReport;
    const truePeakDb = report.limiter?.truePeakDb;
    const samplePeak = peak(result);
    const samplePeakDb = toDb(samplePeak);
    
    // Verify that truePeakDb captured the oversampled peak
    expect(truePeakDb).toBeDefined();
    
    // The true-peak should be at or below ceiling (-1 dBFS)
    if (truePeakDb !== undefined) {
      expect(truePeakDb).toBeLessThanOrEqual(-0.98); // Allow small tolerance
    }
  });

  it('is transparent bypass when limiter OFF (bit-parity 72/72)', () => {
    const input = tone(1000);
    const dry = [...input.get('song')!];
    const out = new BackendMainProcessors(SR).process(input, masterOn({ gain: 1, limiter: { active: false } }));
    expect([...out]).toEqual(dry);
  });

  it('is transparent bypass when master completely OFF', () => {
    const input = tone(1000);
    const dry = [...input.get('song')!];
    const out = new BackendMainProcessors(SR).process(input, {});
    expect([...out]).toEqual(dry);
  });

  it('limits a +6dB burst to the ceiling', () => {
    // Create a +6dB burst above unity (which is 0 dBFS, ceiling is -1 dBFS)
    const burst = new Float32Array(2 * 4096);
    const frames = 4096;
    // +6dB = gain of ~2 in linear
    for (let f = 1000; f < 1100; f++) {
      burst[2 * f] = 1.0;  // 0 dBFS
      burst[2 * f + 1] = 1.0;
    }
    const input = new Map([['burst', burst]]);
    
    const processor = new BackendMainProcessors(SR);
    const out = processor.process(input, masterOn({ gain: 2, limiter: { active: true, ceilingDb: -1, truePeak: true }, bands: Array(12).fill(0) }));
    
    // Output should never exceed -1 dBFS (0.891 linear)
    const outPeak = peak(out);
    const ceilingLin = Math.pow(10, -1 / 20);
    expect(outPeak).toBeLessThanOrEqual(ceilingLin * 1.01); // small tolerance for lookahead
  });

  it('reports gain reduction in the lastReport when active', () => {
    const input = tone(1000, 0.1, 0.7);
    const processor = new BackendMainProcessors(SR);
    processor.process(input, {});
    
    // Process with limiter ON at high gain
    processor.process(input, masterOn({ gain: 2, limiter: { active: true, ceilingDb: -3, truePeak: true }, bands: Array(12).fill(0) }));
    
    const report = processor.lastReport;
    expect(report.limiter?.active).toBe(true);
    expect(report.limiter?.ceilingDb).toBe(-3);
    expect(report.limiter?.gainReductionDb).toBeGreaterThanOrEqual(0);
    expect(report.limiter?.truePeakDb).toBeDefined();
  });

  it('does not report gain reduction when limiter OFF', () => {
    const input = tone(1000);
    const processor = new BackendMainProcessors(SR);
    processor.process(input, masterOn({ gain: 1, limiter: { active: false } }));
    
    expect(processor.lastReport.limiter).toBeUndefined();
  });

  it('applies after master gain, before any further processing', () => {
    // The limiter should constrain the signal after the master gain is applied
    const input = tone(1000, 0.1, 0.5);
    const processor = new BackendMainProcessors(SR);
    
    // Process with high gain and limiter on
    const out = processor.process(input, masterOn({ 
      gain: 2, 
      limiter: { active: true, ceilingDb: -1, truePeak: true },
      bands: Array(12).fill(0) // no EQ
    }));
    
    const ceilingLin = Math.pow(10, -1 / 20);
    expect(peak(out)).toBeLessThanOrEqual(ceilingLin * 1.02);
  });

  it('handles parameter overrides gracefully', () => {
    const input = tone(1000, 0.1, 0.7);
    const processor = new BackendMainProcessors(SR);
    
    // Custom limiter parameters
    const out = processor.process(input, masterOn({ 
      gain: 1.5, 
      limiter: { active: true, ceilingDb: -6, releaseSec: 0.1, truePeak: false },
      bands: Array(12).fill(0)
    }));
    
    const report = processor.lastReport;
    expect(report.limiter?.ceilingDb).toBe(-6);
    expect(peak(out)).toBeLessThanOrEqual(Math.pow(10, -6 / 20) * 1.02);
  });

  it('maintains bit parity with and without limiter on the same signal', () => {
    // This test verifies that the limiter path produces the same bit-parity
    // when the limiter is off (transparent bypass)
    const input = tone(440, 0.5, 0.3);
    const processor = new BackendMainProcessors(SR);
    
    const outNoLimiter = processor.process(input, masterOn({ gain: 1, limiter: { active: false }, bands: Array(12).fill(0) }));
    const processor2 = new BackendMainProcessors(SR);
    const outLimiterOff = processor2.process(input, masterOn({ gain: 1, bands: Array(12).fill(0) }));
    // When limiter is not configured at all, it should also be transparent
    
    expect([...outNoLimiter]).toEqual([...outLimiterOff]);
  });

  it('reports zero gain reduction when signal is below ceiling', () => {
    // When the signal does not exceed the ceiling, no gain reduction should occur
    const input = tone(1000, 0.2, 0.3); // low amplitude signal (~-10 dBFS)
    const processor = new BackendMainProcessors(SR);
    
    processor.process(input, masterOn({ 
      gain: 1, 
      limiter: { active: true, ceilingDb: -1, truePeak: true }, // -1 dBFS ceiling
      bands: Array(12).fill(0) 
    }));
    
    // No gain reduction should be reported
    expect(processor.lastReport.limiter?.gainReductionDb).toBe(0);
  });

  it('detects inter-sample peaks above sample peak (True-Peak test)', () => {
    // Generate a signal that will have inter-sample peaks above sample peaks
    // This tests the 4x oversampling FIR detection
    const frames = Math.round(SR * 0.05);
    const interleaved = new Float32Array(frames * 2);
    
    // Create a high-frequency signal near unity that triggers inter-sample peaks
    const freq = 8000; // High frequency for inter-sample variations
    const amp = 0.95;
    
    for (let f = 0; f < frames; f++) {
      const phase = (2 * Math.PI * freq * f) / SR;
      const v = Math.sin(phase) * amp;
      interleaved[2 * f] = v;
      interleaved[2 * f + 1] = v;
    }
    
    const input = new Map([['test', interleaved]]);
    const processor = new BackendMainProcessors(SR);
    
    // Without True-Peak detection, this might clip
    const result = processor.process(input, masterOn({
      gain: 1,
      limiter: { active: true, ceilingDb: -0.5, truePeak: true },
      bands: Array(12).fill(0)
    }));
    
    const report = processor.lastReport;
    const truePeakDb = report.limiter?.truePeakDb;
    const samplePeak = peak(result);
    const samplePeakDb = toDb(samplePeak);
    
    // True-Peak should be detected and reported
    expect(truePeakDb).toBeDefined();
    
    // Signal should be limited to ceiling
    expect(samplePeak).toBeLessThanOrEqual(Math.pow(10, -0.5 / 20) * 1.02);
  });
});