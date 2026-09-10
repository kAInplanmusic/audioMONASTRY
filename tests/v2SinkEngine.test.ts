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

  it('Sample-Player spielt einen Buffer als V2-Source und stoppt am Ende (Phase 3)', () => {
    const engine = new V2SinkEngine(48000, 128);
    const source = new Float32Array(256);
    source.fill(0.5);
    engine.setSampleBuffer('channel1', source, null, 48000);
    expect(engine.hasSample('channel1')).toBe(true);
    expect(engine.triggerSample('channel1')).toBe(true);
    expect(engine.isSamplePlaying('channel1')).toBe(true);

    const b1 = engine.render({ ...CTX, currentTime: 0 });
    expect(b1[0].some((v) => Math.abs(v) > 0.01)).toBe(true);
    expect(engine.isSamplePlaying('channel1')).toBe(true);

    engine.render({ ...CTX, currentTime: 128 / 48000 });
    // Nach zwei vollen Blöcken (256 Samples) ist der One-Shot beendet.
    expect(engine.isSamplePlaying('channel1')).toBe(false);
    const after = engine.render({ ...CTX, currentTime: 256 / 48000 });
    expect(after[0].some((v) => Math.abs(v) > 1e-7)).toBe(false);
  });

  it('Sample-Player unterstützt Loop als V2-Source (Phase 3)', () => {
    const engine = new V2SinkEngine(48000, 128);
    const source = new Float32Array(128);
    source.fill(0.5);
    engine.setSampleBuffer('channel2', source, null, 48000);
    engine.triggerSample('channel2', { loop: true });
    for (let i = 0; i < 5; i++) {
      const out = engine.render({ ...CTX, currentTime: i * 128 / 48000 });
      expect(out[0].some((v) => Math.abs(v) > 0.01)).toBe(true);
    }
    expect(engine.isSamplePlaying('channel2')).toBe(true);
  });

  it('External Source (SFZ/Instrument) wird als V2-Quelle übernommen und nicht nachgehalten', () => {
    const engine = new V2SinkEngine(48000, 128);
    const block = new Float32Array(128);
    block.fill(0.4);
    engine.setExternalSource('channel3', [block]);
    const out = engine.render({ ...CTX, currentTime: 0 });
    expect(out[0].some((v) => Math.abs(v) > 0.01)).toBe(true);

    // Im nächsten Block ohne External Source ist der Kanal wieder stumm.
    const silent = engine.render({ ...CTX, currentTime: 128 / 48000 });
    expect(silent[0].some((v) => Math.abs(v) > 1e-7)).toBe(false);
  });
});

describe('V2SinkEngine · AUDIO-P0-001/003/004 (Drum-Stimmen, Mute, Master-Processing)', () => {
  function rmsOf(block: Float32Array[]): number {
    return blockRms(block);
  }

  function renderBlockWith(engine: V2SinkEngine, event: { track: 'channel1' | 'channel2'; startSample: number; velocity: number; freq: number }): Float32Array[] {
    return engine.render({ ...CTX, currentTime: 0 }, [event]);
  }

  it('AUDIO-P0-001: Kick- und Hat-Stimme erzeugen unterschiedliche Signale (kein 440-Hz-Einheits-Sinus)', () => {
    const kick = new V2SinkEngine(48000, 128);
    const hat = new V2SinkEngine(48000, 128);

    kick.setSynthSource('channel1', { freq: 50, voice: 'kick' });
    hat.setSynthSource('channel2', { freq: 6000, voice: 'hat' });

    const kickOut = renderBlockWith(kick, { track: 'channel1', startSample: 0, velocity: 1, freq: 50 });
    const hatOut = renderBlockWith(hat, { track: 'channel2', startSample: 0, velocity: 1, freq: 6000 });

    expect(rmsOf(kickOut)).toBeGreaterThan(0.01);
    expect(rmsOf(hatOut)).toBeGreaterThan(0.01);

    let diff = 0;
    for (let i = 0; i < 128; i++) diff += Math.abs(kickOut[0][i] - hatOut[0][i]);
    expect(diff / 128).toBeGreaterThan(0.02);
  });

  it('AUDIO-P0-001: stummgeschalteter Kanal triggert keine Stimme', () => {
    const engine = new V2SinkEngine(48000, 128);
    engine.setSynthSource('channel1', { freq: 440, voice: 'lead' });
    engine.setChannelMuted('channel1', true);
    const out = engine.render({ ...CTX, currentTime: 0 }, [{ track: 'channel1', startSample: 0, velocity: 1, freq: 440 }]);
    expect(rmsOf(out)).toBeLessThan(1e-6);

    engine.setChannelMuted('channel1', false);
    const unmuted = engine.render({ ...CTX, currentTime: 128 / 48000 }, [{ track: 'channel1', startSample: 0, velocity: 1, freq: 440 }]);
    expect(rmsOf(unmuted)).toBeGreaterThan(0.01);
  });

  it('AUDIO-P0-003: triggerSynth rendert im nächsten Block hörbaren Output', () => {
    const engine = new V2SinkEngine(48000, 128);
    engine.setSynthSource('channel8', { freq: 880, voice: 'lead' });
    engine.triggerSynth('channel8', 1);
    const out = engine.render({ ...CTX, currentTime: 0 });
    expect(rmsOf(out)).toBeGreaterThan(0.01);
    // Ohne erneuten Trigger ist der nächste Block wieder stumm.
    const silent = engine.render({ ...CTX, currentTime: 128 / 48000 });
    expect(rmsOf(silent)).toBeLessThan(1e-6);
  });

  it('AUDIO-P0-004: Master-EQ-Boost hebt den Pegel eines Tons im Durchlassbereich an', () => {
    const flat = new V2SinkEngine(48000, 128);
    const boosted = new V2SinkEngine(48000, 128);
    flat.setMasterEq(0, 0, 0);
    boosted.setMasterEq(12, 0, 0);

    // Niedriger Pegel (unter Mastering-Threshold), damit nur der EQ wirkt.
    const flatOut = renderBlockWith(flat, { track: 'channel1', startSample: 0, velocity: 0.05, freq: 220 });
    const boostedOut = renderBlockWith(boosted, { track: 'channel1', startSample: 0, velocity: 0.05, freq: 220 });
    expect(rmsOf(boostedOut)).toBeGreaterThan(rmsOf(flatOut) * 1.5);
  });

  it('AUDIO-P0-004: Mastering-Limiter hält den Output unter dem Ceiling', () => {
    const engine = new V2SinkEngine(48000, 128);
    engine.setMasterGain(2);
    engine.setMasterMastering(-14, 4, 1.5, 0.5);
    engine.setTestTone(true, 440, 0.9);
    const out = renderSeconds(engine, 0.05);
    let peak = 0;
    for (const ch of out) for (const v of ch) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(0.5 + 1e-3);
  });

  it('AUDIO-P0-004: Dynamics-Insert dämpft lautes Material, Bypass lässt es unverändert', () => {
    const bypass = new V2SinkEngine(48000, 128);
    const active = new V2SinkEngine(48000, 128);
    bypass.setMasterDynamics(false, -18, 3, 0);
    active.setMasterDynamics(true, -35, 8, 0);

    // Dauerton (unter Mastering-Threshold, über Dynamics-Threshold) und
    // genügend Blöcke rendern, damit der Kompressor einschwingt.
    bypass.setTestTone(true, 220, 0.05);
    active.setTestTone(true, 220, 0.05);
    const bypassOut = renderSeconds(bypass, 0.1);
    const activeOut = renderSeconds(active, 0.1);
    expect(rmsOf(activeOut)).toBeLessThan(rmsOf(bypassOut) * 0.8);
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
    expect(sink.setSampleBuffer('channel1', new Float32Array(16))).toBe(false);
    expect(sink.triggerSample('channel1')).toBe(false);
    expect(sink.stopSample('channel1')).toBe(false);
    expect(sink.setSynthSource('channel1', 440)).toBe(false);
    expect(sink.loadSfzBank('channel1', '<region/>', {})).toBe(false);
    expect(sink.sfzNoteOn('channel1', 60)).toBe(false);
    expect(sink.sfzNoteOff('channel1', 60)).toBe(false);
    expect(sink.disconnect()).toBeUndefined();
  });
});
