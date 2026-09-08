import { describe, expect, it } from 'vitest';
import { V2SinkEngine } from '../src/core/audio/live/V2SinkEngine';
import { V2LiveSink } from '../src/core/audio/backends/V2LiveSink';
import type { IProcessingContext } from '../src/core/audio/types';

const CTX: IProcessingContext = {
  sampleRate: 48000,
  bufferSize: 128,
  quantum: 128 / 48000,
  currentTime: 0,
};

function blockRms(block: Float32Array[]): number {
  let sum = 0;
  let count = 0;
  for (const channel of block) {
    for (let i = 0; i < channel.length; i++) {
      sum += channel[i] * channel[i];
      count++;
    }
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

function renderSeconds(engine: V2SinkEngine, seconds: number): Float32Array[] {
  const blocks = Math.max(1, Math.ceil((seconds * CTX.sampleRate) / CTX.bufferSize));
  const out: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  for (let b = 0; b < blocks; b++) {
    const rendered = engine.render(CTX);
    if (!rendered || rendered.length === 0) continue;
    if (out[0].length === 0) {
      out[0] = rendered[0].slice();
      out[1] = (rendered[1] ?? rendered[0]).slice();
    } else {
      const nextL = new Float32Array(out[0].length + rendered[0].length);
      nextL.set(out[0]);
      nextL.set(rendered[0], out[0].length);
      out[0] = nextL;
      const right = rendered[1] ?? rendered[0];
      const nextR = new Float32Array(out[1].length + right.length);
      nextR.set(out[1]);
      nextR.set(right, out[1].length);
      out[1] = nextR;
    }
  }
  return out;
}

describe('V2SinkEngine (Phase 1 – V2 hörbar machen)', () => {
  it('rendert bei aktivem Testton einen nachweisbar hörbaren Stereo-Block', () => {
    const engine = new V2SinkEngine(48000, 128);
    engine.setTestTone(true, 440, 0.2);

    const out = renderSeconds(engine, 0.25);
    const rms = blockRms(out);
    expect(rms).toBeGreaterThan(0.01);
    expect(out[0].length).toBeGreaterThan(0);
    expect(out[1].length).toBeGreaterThan(0);
  });

  it('liefert Stille, sobald der Testton gestoppt ist (kein Nachklingen)', () => {
    const engine = new V2SinkEngine(48000, 128);
    engine.setTestTone(true, 440, 0.2);
    renderSeconds(engine, 0.05);

    engine.setTestTone(false);
    const silent = renderSeconds(engine, 0.05);
    expect(blockRms(silent)).toBeLessThan(1e-6);
  });

  it('Kanal-Gain in dB reduziert den Pegel im V2-Graph', () => {
    const full = new V2SinkEngine(48000, 128);
    full.setTestTone(true, 440, 0.2);
    const fullOut = renderSeconds(full, 0.05);

    const quiet = new V2SinkEngine(48000, 128);
    quiet.setTestTone(true, 440, 0.2);
    quiet.setChannelGainDb('channel1', -12);
    const quietOut = renderSeconds(quiet, 0.05);

    expect(blockRms(quietOut)).toBeLessThan(blockRms(fullOut) * 0.6);
  });

  it('Master-Gain 0 macht den V2-Output stumm', () => {
    const engine = new V2SinkEngine(48000, 128);
    engine.setTestTone(true, 440, 0.2);
    engine.setMasterGain(0);
    const out = renderSeconds(engine, 0.05);
    expect(blockRms(out)).toBeLessThan(1e-6);
  });

  it('Step-Event startet sample-genau innerhalb des Blocks (Phase 2)', () => {
    const engine = new V2SinkEngine(48000, 128);
    const ctx: IProcessingContext = { ...CTX, currentTime: 0 };
    const out = engine.render(ctx, [{ track: 'channel1', startSample: 64, velocity: 1, freq: 440 }]);

    for (let i = 0; i < 64; i++) {
      expect(out[0][i], `Sample ${i} sollte vor dem Step stumm sein`).toBe(0);
      expect(out[1][i]).toBe(0);
    }
    const after = out[0].subarray(64);
    expect(after.some((v) => Math.abs(v) > 0.01)).toBe(true);
  });
});

describe('V2LiveSink (Browser-Adapter, Node-No-Op)', () => {
  it('connect() ist ohne AudioContext ein sicherer No-Op', async () => {
    const sink = new V2LiveSink();
    expect(sink.isConnected).toBe(false);
    await expect(sink.connect(null)).resolves.toBe(false);
  });

  it('Steuerbefehle ohne Verbindung liefern false statt zu crashen', () => {
    const sink = new V2LiveSink();
    expect(sink.startTestTone()).toBe(false);
    expect(sink.stopTestTone()).toBe(false);
    expect(sink.setChannelGainDb('channel1', -6)).toBe(false);
    expect(sink.setChannelPan('channel1', 0)).toBe(false);
    expect(sink.setMasterGain(1)).toBe(false);
    expect(sink.startTransport({ bpm: 120 })).toBe(false);
    expect(sink.updateTransport({ swing: 0.1 })).toBe(false);
    expect(sink.stopTransport()).toBe(false);
    expect(sink.setPattern('channel1', Array(16).fill(true))).toBe(false);
    expect(sink.disconnect()).toBeUndefined();
  });
});
