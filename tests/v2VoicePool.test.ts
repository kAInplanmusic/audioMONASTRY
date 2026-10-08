// @vitest-environment node
/**
 * RT-AUDIT-P0-001 / RT-AUDIT-P0-003: Voice-Pool + Step-Queue des V2-Live-Pfads
 * ============================================================================
 * Der hörbare Ausgang der App läuft ausschließlich über v2SinkProcessor →
 * V2SinkEngine → V2MonitorGraph. Gemessen (npm run audit:rt) war:
 *   - P0-001: ein Kick-Step klang genau einen Block (2,67 ms), danach Stille.
 *   - P0-003: mit Swing > 0 wurden 7–8 von 16 Steps pro Takt verworfen.
 *   - Nebenbefund: Step-Samples starteten am Blockanfang statt am Step-Sample.
 *
 * Diese Tests sichern die Korrektur ab: persistente Stimmen (Pool mit 32
 * Slots, Mono-Ausblendung, Mute-Ausblendung), die Event-Queue mit absoluten
 * Frames (V2StepQueue) und sample-genaue Sample-Trigger.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { V2SinkEngine, V2_MAX_VOICES, V2_VOICE_FADE_SAMPLES } from '../src/core/audio/live/V2SinkEngine';
import { V2SampleClock, type V2ScheduledStep } from '../src/core/audio/live/V2SampleClock';
import { V2StepQueue } from '../src/core/audio/live/V2StepQueue';
import { renderElectricPiano } from '../src/core/dsp/electricPiano';
import type { V2Channel } from '../src/core/audio/V2StudioGraph';
import type { IProcessingContext } from '../src/core/audio/types';

const SR = 48000;
const N = 128;

const ctx = (block: number): IProcessingContext => ({
  sampleRate: SR,
  bufferSize: N,
  quantum: N / SR,
  currentTime: (block * N) / SR,
});

function rms(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / Math.max(1, a.length));
}

/** Mono-Quellpuffer eines Kanals VOR dem Graph (Stimmen-Mix des letzten Blocks). */
function sourceOf(engine: V2SinkEngine, channel: V2Channel): Float32Array {
  const buffer = engine.studio.sources.get(channel)?.sourceBuffer?.[0];
  if (!buffer) throw new Error(`keine Quelle auf ${channel}`);
  return buffer;
}

/** Rendert `blocks` Blöcke und hängt den Quellpuffer eines Kanals aneinander. */
function captureSource(engine: V2SinkEngine, channel: V2Channel, blocks: number, from = 0): Float32Array {
  const out = new Float32Array(blocks * N);
  for (let b = 0; b < blocks; b++) {
    engine.render(ctx(from + b));
    out.set(sourceOf(engine, channel), b * N);
  }
  return out;
}

describe('RT-AUDIT-P0-001: persistenter Voice-Pool', () => {
  it('Kick-Step ist ≥ 100 ms hörbar und nach spätestens 2,1 s still', () => {
    const engine = new V2SinkEngine(SR, N);
    const blocks = Math.ceil((2.1 * SR) / N);
    let audibleBlocks = 0;
    let lastRms = 1;
    for (let b = 0; b < blocks; b++) {
      const events = b === 0 ? [{ track: 'channel1' as const, startSample: 0, velocity: 0.8, freq: 50 }] : undefined;
      const out = engine.render(ctx(b), events);
      lastRms = rms(out[0]);
      if (lastRms > 1e-3) audibleBlocks++;
    }
    const audibleMs = (audibleBlocks * N / SR) * 1000;
    expect(audibleMs).toBeGreaterThanOrEqual(100);
    expect(lastRms).toBeLessThan(1e-6);
    expect(engine.activeVoiceCount).toBe(0);
  });

  it('Stimme setzt die Klangformel lückenlos über Blockgrenzen fort (E-Piano = renderElectricPiano)', () => {
    const engine = new V2SinkEngine(SR, N);
    engine.setSynthSource('channel5', { freq: 220, voice: 'epiano', modIndex: 2.4 });
    engine.scheduleSynth('channel5', 0, 1);
    const captured = captureSource(engine, 'channel5', 20);
    // Referenz: der frühere Puffer-Weg (eine Note, Gain 1) × Velocity-Amplitude 0,8.
    const reference = renderElectricPiano(220, { sampleRate: SR, durationS: 1, modIndex: 2.4, gain: 1 });
    for (let i = 0; i < captured.length; i++) {
      const expected = Math.fround(Math.max(-1, Math.min(1, reference[i] * 0.8)));
      expect(Math.abs(captured[i] - expected)).toBeLessThan(1e-6);
    }
  });

  it('zwei überlappende Lead-Trigger auf demselben Kanal sind beide hörbar (polyphon)', () => {
    const both = new V2SinkEngine(SR, N);
    const onlySecond = new V2SinkEngine(SR, N);
    for (const engine of [both, onlySecond]) engine.setSynthSource('channel2', { freq: 440, voice: 'lead' });

    both.scheduleSynth('channel2', 0, 1, 330);
    both.render(ctx(0));
    both.render(ctx(1));
    both.scheduleSynth('channel2', 10, 1, 440);
    onlySecond.render(ctx(0));
    onlySecond.render(ctx(1));
    onlySecond.scheduleSynth('channel2', 10, 1, 440);

    both.render(ctx(2));
    onlySecond.render(ctx(2));
    expect(both.activeVoiceCount).toBe(2);
    const a = sourceOf(both, 'channel2');
    const b = sourceOf(onlySecond, 'channel2');
    // Differenz = Beitrag der ersten Stimme → sie klingt weiter.
    const diff = new Float32Array(N);
    for (let i = 0; i < N; i++) diff[i] = a[i] - b[i];
    expect(rms(diff)).toBeGreaterThan(1e-3);
    // Die zweite Stimme klingt ebenfalls (ab Sample 10).
    expect(rms(b.subarray(10))).toBeGreaterThan(1e-3);
  });

  it('zweiter Kick-Trigger blendet den ersten in 64 Samples ohne Sprung > 0,1 aus (monophon)', () => {
    const START = 40;
    const both = new V2SinkEngine(SR, N);
    const onlySecond = new V2SinkEngine(SR, N);
    both.scheduleSynth('channel1', 0, 1);
    // Erster Kick läuft 3 Blöcke; der zweite kommt im 4. Block bei Sample 40.
    for (let b = 0; b < 3; b++) {
      both.render(ctx(b));
      onlySecond.render(ctx(b));
    }
    both.scheduleSynth('channel1', START, 1);
    onlySecond.scheduleSynth('channel1', START, 1);

    const old = new Float32Array(2 * N);
    for (let b = 3; b < 5; b++) {
      both.render(ctx(b));
      onlySecond.render(ctx(b));
      const a = sourceOf(both, 'channel1');
      const s = sourceOf(onlySecond, 'channel1');
      for (let i = 0; i < N; i++) old[(b - 3) * N + i] = a[i] - s[i];
    }
    // Ohne Ausblendung wäre der Kick hier hart abgerissen: Pegel am Schnitt prüfen.
    expect(Math.abs(old[START - 1])).toBeGreaterThan(0.1);
    // Ausblendung: keine Sprünge > 0,1 im Beitrag des ersten Kicks …
    let maxJump = 0;
    for (let i = 1; i < old.length; i++) maxJump = Math.max(maxJump, Math.abs(old[i] - old[i - 1]));
    expect(maxJump).toBeLessThan(0.1);
    // … und nach genau 64 Samples ist er vollständig weg.
    for (let i = START + V2_VOICE_FADE_SAMPLES; i < old.length; i++) {
      expect(Math.abs(old[i])).toBeLessThan(1e-6);
    }
    expect(both.activeVoiceCount).toBe(1);
  });

  it('Bass-Filterzustand ist je Stimme getrennt (zwei Kanäle beeinflussen sich nicht)', () => {
    const solo = new V2SinkEngine(SR, N);
    const duo = new V2SinkEngine(SR, N);
    for (const engine of [solo, duo]) engine.setSynthSource('channel8', { freq: 55, voice: 'bass' });
    duo.setSynthSource('channel7', { freq: 110, voice: 'bass' });
    solo.scheduleSynth('channel8', 0, 1);
    duo.scheduleSynth('channel8', 0, 1);
    duo.scheduleSynth('channel7', 0, 1);
    for (let b = 0; b < 10; b++) {
      solo.render(ctx(b));
      duo.render(ctx(b));
      const a = sourceOf(solo, 'channel8');
      const d = sourceOf(duo, 'channel8');
      for (let i = 0; i < N; i++) expect(d[i]).toBe(a[i]);
    }
  });

  it('Mute während einer klingenden Stimme: nach 64 Samples Stille, keine neuen Stimmen', () => {
    const engine = new V2SinkEngine(SR, N);
    engine.setSynthSource('channel2', { freq: 440, voice: 'lead' });
    engine.scheduleSynth('channel2', 0, 1);
    engine.render(ctx(0));
    engine.render(ctx(1));
    expect(rms(sourceOf(engine, 'channel2'))).toBeGreaterThan(1e-2);

    engine.setChannelMuted('channel2', true);
    engine.render(ctx(2));
    const faded = sourceOf(engine, 'channel2');
    // Ausblendung (nicht hart abgerissen) …
    expect(Math.abs(faded[0])).toBeGreaterThan(0);
    // … und ab Sample 64 exakt still.
    for (let i = V2_VOICE_FADE_SAMPLES; i < N; i++) expect(faded[i]).toBe(0);
    expect(engine.activeVoiceCount).toBe(0);

    // Neue Trigger auf dem stummen Kanal starten keine Stimme.
    engine.scheduleSynth('channel2', 0, 1);
    engine.render(ctx(3));
    expect(engine.activeVoiceCount).toBe(0);
    expect(rms(sourceOf(engine, 'channel2'))).toBe(0);
  });

  it('Pool-Überlauf (40 Trigger): keine Exception, höchstens 32 aktive Stimmen', () => {
    const engine = new V2SinkEngine(SR, N);
    engine.setSynthSource('channel4', { freq: 440, voice: 'lead' });
    expect(() => {
      for (let k = 0; k < 40; k++) engine.scheduleSynth('channel4', k, 1, 200 + k * 10);
      engine.render(ctx(0));
    }).not.toThrow();
    expect(engine.activeVoiceCount).toBe(V2_MAX_VOICES);
    expect(Number.isFinite(rms(sourceOf(engine, 'channel4')))).toBe(true);
  });

  it('reset() leert den Voice-Pool', () => {
    const engine = new V2SinkEngine(SR, N);
    engine.scheduleSynth('channel1', 0, 1);
    engine.render(ctx(0));
    expect(engine.activeVoiceCount).toBe(1);
    engine.reset();
    expect(engine.activeVoiceCount).toBe(0);
    expect(rms(engine.render(ctx(1))[0])).toBeLessThan(1e-6);
  });
});

describe('RT-AUDIT-P0-001 (Nebenbefund): sample-genaue Sample-Trigger', () => {
  it('Sample-Trigger mit startSample 77: vor Sample 77 = 0, ab 77 ≠ 0', () => {
    const engine = new V2SinkEngine(SR, N);
    const source = new Float32Array(1024).fill(0.5);
    engine.setSampleBuffer('channel2', source, null, SR);
    expect(engine.triggerSample('channel2', { startSample: 77 })).toBe(true);
    engine.render(ctx(0));
    const block = sourceOf(engine, 'channel2');
    for (let i = 0; i < 77; i++) expect(block[i]).toBe(0);
    for (let i = 77; i < N; i++) expect(block[i]).not.toBe(0);
  });

  it('Retrigger: laufendes Sample spielt bis zum neuen Startsample weiter', () => {
    const engine = new V2SinkEngine(SR, N);
    const source = new Float32Array(4096);
    for (let i = 0; i < source.length; i++) source[i] = (i + 1) / source.length;
    engine.setSampleBuffer('channel2', source, null, SR);
    engine.triggerSample('channel2');
    engine.render(ctx(0)); // Position 128
    engine.triggerSample('channel2', { startSample: 50 });
    engine.render(ctx(1));
    const block = sourceOf(engine, 'channel2');
    expect(block[0]).toBeCloseTo(source[128], 6);
    expect(block[49]).toBeCloseTo(source[177], 6);
    expect(block[50]).toBeCloseTo(source[0], 6);
  });
});

describe('RT-AUDIT-P0-003: Event-Queue mit absoluten Frames (Swing)', () => {
  it('processBlockInto liefert dieselben Steps wie processBlock (ohne Allokation)', () => {
    const a = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 133, swing: 0.3 });
    const b = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 133, swing: 0.3 });
    a.playing = true;
    b.playing = true;
    const out: V2ScheduledStep[] = [{ step: 0, frame: 0, time: 0, swing: 0, gate: 0, secondsPerStep: 0 }];
    const first = out[0];
    for (let f = 0; f < SR * 2; f += N) {
      const expected = a.processBlock(f, N);
      const count = b.processBlockInto(f, N, out);
      expect(count).toBe(expected.length);
      for (let k = 0; k < count; k++) expect(out[k]).toEqual(expected[k]);
    }
    // Das vorallokierte Ergebnisobjekt wird wiederverwendet.
    expect(out[0]).toBe(first);
  });

  it('Swing 0,5 bei 120 BPM über 2 Takte: alle 32 Steps feuern, ungerade exakt +1500 Samples', () => {
    const clock = new V2SampleClock({ sampleRate: SR, stepCount: 16, bpm: 120, swing: 0.5 });
    clock.playing = true;
    const queue = new V2StepQueue(64);
    const planned: V2ScheduledStep[] = [{ step: 0, frame: 0, time: 0, swing: 0, gate: 0, secondsPerStep: 0 }];
    const starts = new Int32Array(64);
    const steps = new Int32Array(64);
    const frames = new Float64Array(64);
    const sps = new Float64Array(64);
    const firedFrames: number[] = [];
    const firedSteps: number[] = [];

    // 2 Takte = 32 Sechzehntel à 6000 Samples; erster Step bei Frame 6000.
    const totalFrames = 6000 * 32 + 1500 + N; // letzter (ungerader) Step bei 193.500
    for (let f = 0; f < totalFrames; f += N) {
      const count = clock.processBlockInto(f, N, planned);
      for (let k = 0; k < count; k++) queue.push(planned[k].frame, planned[k].step, planned[k].secondsPerStep);
      const fired = queue.popDue(f, N, starts, steps, frames, sps);
      for (let k = 0; k < fired; k++) {
        // Startsample liegt immer im aktuellen Block.
        expect(starts[k]).toBeGreaterThanOrEqual(0);
        expect(starts[k]).toBeLessThan(N);
        firedFrames.push(f + starts[k]);
        firedSteps.push(steps[k]);
      }
    }

    expect(firedFrames.length).toBe(32);
    expect(queue.overflowCount).toBe(0);
    const swingOffset = 6000 * 0.5 * 0.5; // = 1500 Samples
    for (let k = 0; k < 32; k++) {
      const grid = 6000 * (k + 1);
      expect(firedSteps[k]).toBe(k % 16);
      if (k % 2 === 0) expect(firedFrames[k]).toBe(grid);
      else expect(firedFrames[k]).toBe(firedFrames[k - 1] + 6000 + swingOffset);
    }
  });

  it('verspätete Einträge feuern bei Startsample 0, die Queue bleibt nach Frame sortiert', () => {
    const queue = new V2StepQueue(4);
    const starts = new Int32Array(4);
    const steps = new Int32Array(4);
    const frames = new Float64Array(4);
    const sps = new Float64Array(4);
    expect(queue.push(1000, 2)).toBe(true);
    expect(queue.push(300, 1)).toBe(true); // außer der Reihe
    expect(queue.push(90, 0)).toBe(true); // verspätet
    expect(queue.push(5000, 3)).toBe(true);
    expect(queue.push(6000, 4)).toBe(false); // voll
    expect(queue.overflowCount).toBe(1);

    expect(queue.popDue(128, 128, starts, steps, frames, sps)).toBe(1);
    expect(starts[0]).toBe(0);
    expect(steps[0]).toBe(0);
    expect(queue.popDue(256, 128, starts, steps, frames, sps)).toBe(1);
    expect(starts[0]).toBe(300 - 256);
    expect(steps[0]).toBe(1);
    expect(queue.size).toBe(2);
    queue.clear();
    expect(queue.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: echter v2SinkProcessor (AudioWorklet-Globals gestubbt)
// ---------------------------------------------------------------------------
interface ProcessorInstance {
  port: { onmessage: ((e: { data?: Record<string, unknown> }) => void) | null; postMessage: (m: Record<string, unknown>) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorCtor = new () => ProcessorInstance;
let Processor: ProcessorCtor | null = null;

describe('RT-AUDIT-P0-003: v2SinkProcessor feuert mit Swing alle Steps', () => {
  beforeAll(async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.sampleRate = SR;
    g.currentFrame = 0;
    g.currentTime = 0;
    g.AudioWorkletProcessor = class {
      port = { onmessage: null, postMessage: () => {} };
    };
    g.registerProcessor = (_name: string, ctor: ProcessorCtor) => {
      Processor = ctor;
    };
    await import('../src/audio/worklets/v2SinkProcessor.ts');
  });

  it('Swing 0,5: 32 Step-Meldungen über 2 Takte, Kick klingt über mehrere Blöcke', () => {
    if (!Processor) throw new Error('v2SinkProcessor nicht geladen');
    const p = new Processor();
    const messages: Record<string, unknown>[] = [];
    p.port.postMessage = (m) => { messages.push(m); };
    p.port.onmessage?.({ data: { type: 'pattern', channel: 'channel1', steps: Array(16).fill(true) } });
    p.port.onmessage?.({ data: { type: 'transport', playing: true, bpm: 120, swing: 0.5, gate: 0.9, stepCount: 16 } });

    const g = globalThis as unknown as Record<string, number>;
    const blockRms: number[] = [];
    for (let f = 0; f < 6000 * 32 + 1500 + N; f += N) {
      g.currentFrame = f;
      g.currentTime = f / SR;
      const output = [new Float32Array(N), new Float32Array(N)];
      p.process([], [output]);
      blockRms.push(rms(output[0]));
    }
    const stepMsgs = messages.filter((m) => m.type === 'step');
    expect(stepMsgs.length).toBe(32);
    // Ungerade Steps liegen exakt 1500 Samples hinter dem Raster.
    expect(Math.round((stepMsgs[1].time as number) * SR)).toBe(12000 + 1500);
    // Der erste Kick (Frame 6000 = Block 46) klingt deutlich länger als einen Block.
    const audible = blockRms.slice(46, 46 + 40).filter((v) => v > 1e-3).length;
    expect(audible).toBeGreaterThan(30);
  });
});
