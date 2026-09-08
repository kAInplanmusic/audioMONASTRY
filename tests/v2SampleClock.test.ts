import { describe, expect, it } from 'vitest';
import { V2SampleClock } from '../src/core/audio/live/V2SampleClock';
import { compensateV2StepFrame, V2_MASTERING_LOOKAHEAD_SEC, v2MasteringLookaheadSamples } from '../src/core/audio/live/v2Pdc';

const SR = 48000;
const QUANTUM = 128;

function runBlocks(clock: V2SampleClock, blocks: number, bpm: number | Float32Array, frameStart = 0): number[] {
  const frames: number[] = [];
  for (let b = 0; b < blocks; b++) {
    const events = clock.processBlock(frameStart + b * QUANTUM, QUANTUM, bpm);
    for (const e of events) frames.push(e.frame);
  }
  return frames;
}

describe('V2SampleClock (Phase 2 – sample-genauer Scheduler)', () => {
  it('120 BPM: 16tel-Steps exakt alle 6000 Samples (kein Jitter)', () => {
    const clock = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 120 });
    clock.playing = true;
    clock.reset();

    const frames = runBlocks(clock, 200, 120);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0]).toBe(6000);
    expect(frames[1] - frames[0]).toBe(6000);
    expect(frames.every((f, i) => i === 0 || f - frames[i - 1] === 6000)).toBe(true);
  });

  it('240 BPM: 16tel-Steps exakt alle 3000 Samples', () => {
    const clock = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 240 });
    clock.playing = true;
    clock.reset();

    const frames = runBlocks(clock, 200, 240);
    expect(frames[0]).toBe(3000);
    expect(frames[1] - frames[0]).toBe(3000);
  });

  it('Jitter-/Latenz-Test: 0 ms Step-Jitter, Render-Block bleibt unter dem 8–15-ms-Budget', () => {
    const clock = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 120 });
    clock.playing = true;
    clock.reset();
    const frames = runBlocks(clock, 500, 120);
    const diffsMs = frames.slice(1).map((f, i) => ((f - frames[i]) / SR) * 1000);
    expect(diffsMs.length).toBeGreaterThan(1);
    expect(Math.max(...diffsMs) - Math.min(...diffsMs)).toBe(0);
    // 16tel @ 120 BPM = 125 ms; ein Render-Quantum @48 kHz = 2,67 ms – weit
    // unter dem adaptiven Lookahead-Budget (8–15 ms).
    expect(diffsMs[0]).toBeCloseTo(125, 9);
    expect((QUANTUM / SR) * 1000).toBeLessThanOrEqual(15);
  });

  it('BPM-Wechsel innerhalb eines Quantums wirkt sample-genau (a-rate)', () => {
    // Kontrolle: 46 Quanten konstant 120 BPM → erster Step nach 6000 Samples.
    const control = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 120 });
    control.playing = true;
    control.reset();
    const controlFrames = runBlocks(control, 47, 120);
    expect(controlFrames[0]).toBe(6000);

    // Referenz: erste 64 Samples 120 BPM, dann 240 BPM.
    let expected = -1;
    {
      let phase = 0;
      outer: for (let b = 0; b < 47; b++) {
        for (let i = 0; i < QUANTUM; i++) {
          const bpm = b === 46 && i >= 64 ? 240 : 120;
          const samplesPerStep = (SR * 60) / bpm / 4;
          phase += 1 / samplesPerStep;
          if (phase >= 1) {
            phase -= 1;
            expected = b * QUANTUM + i;
            break outer;
          }
        }
      }
    }
    expect(expected).toBeGreaterThanOrEqual(0);

    const switched = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 120 });
    switched.playing = true;
    switched.reset();
    for (let b = 0; b < 46; b++) switched.processBlock(b * QUANTUM, QUANTUM, 120);
    const bpmArr = new Float32Array(QUANTUM);
    for (let i = 0; i < 64; i++) bpmArr[i] = 120;
    for (let i = 64; i < QUANTUM; i++) bpmArr[i] = 240;
    const switchedFrames = runBlocks(switched, 1, bpmArr, 46 * QUANTUM);

    expect(switchedFrames[0]).toBe(expected);
  });

  it('Swing verzögert ungerade Steps um den sample-gerundeten 16tel-Swing-Anteil', () => {
    const swing = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 120, swing: 0.5 });
    swing.playing = true;
    swing.reset();
    const frames = runBlocks(swing, 200, 120);

    // Step 0 (gerade) exakt bei 6000; Step 1 (ungerade) +1500 Samples Swing.
    expect(frames[0]).toBe(6000);
    expect(frames[1] - frames[0]).toBe(6000 + 1500);
    expect(frames[2] - frames[1]).toBe(6000 - 1500);
  });

  it('stop() liefert keine Events mehr', () => {
    const clock = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 120 });
    clock.playing = true;
    clock.reset();
    runBlocks(clock, 50, 120);
    clock.playing = false;
    expect(clock.processBlock(50 * QUANTUM, QUANTUM, 120)).toEqual([]);
  });
});

describe('V2-PDC (Lookahead-Mastering in V2)', () => {
  it('Lookahead beträgt 5 ms (240 Samples @ 48 kHz) – identisch mit V1-Mastering', () => {
    expect(V2_MASTERING_LOOKAHEAD_SEC).toBe(0.005);
    expect(v2MasteringLookaheadSamples(48000)).toBe(240);
    expect(v2MasteringLookaheadSamples(96000)).toBe(480);
  });

  it('compensateV2StepFrame feuert Step-Frames um den Lookahead früher', () => {
    expect(compensateV2StepFrame(6000, 48000)).toBe(6000 - 240);
  });

  it('V2SampleClock mit PDC-Kompensation liefert Step 0 bei Frame 5760 statt 6000', () => {
    const clock = new V2SampleClock({
      sampleRate: SR,
      stepCount: 16,
      bpm: 120,
      pdcCompensationSamples: v2MasteringLookaheadSamples(SR),
    });
    clock.playing = true;
    clock.reset();
    const frames = runBlocks(clock, 100, 120);
    expect(frames[0]).toBe(6000 - 240);
  });
});
