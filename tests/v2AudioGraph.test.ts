import { describe, expect, it } from 'vitest';
import {  } from '../src/core/audio/AudioGraph';
import { V2StudioGraph } from '../src/core/audio/V2StudioGraph';
import { GraphEngineAdapter } from '../src/core/audio/compat/GraphEngineAdapter';
import { GraphPlaybackEngine } from '../src/core/audio/compat/GraphPlaybackEngine';
import { WorkletGraphRuntime } from '../src/core/audio/WorkletGraphRuntime';

const CTX = { sampleRate: 48000, bufferSize: 128, quantum: 128 / 48000, currentTime: 0 };

function tone(freq: number, len = 128, sr = 48000): Float32Array {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

describe('V2StudioGraph (NEW-D4-1)', () => {
  it('baut 10 Kanäle Source→Gain→Pan→Master und kompiliert ohne Zyklus', () => {
    const studio = new V2StudioGraph();
    const plan = studio.graph.compile();
    expect(plan.validated).toBe(true);
    expect(plan.order.length).toBe(1 + 10 * 3); // Master + (Source, Gain, Pan) × 10
  });

  it('rendert hörbaren Stereoblock (Sinus auf Channel 1)', () => {
    const studio = new V2StudioGraph();
    studio.setSourceBuffer('channel1', [tone(440)]);
    studio.setGainDb('channel1', 0);
    const out = studio.render(CTX);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(2);
    // Linker Kanal dominiert bei Pan 0 gleichverteilt, aber nicht still.
    expect(out![0].some((v) => Math.abs(v) > 0.05)).toBe(true);
    expect(out![1].some((v) => Math.abs(v) > 0.05)).toBe(true);
  });

  it('Pan -1 legt das Signal voll auf links', () => {
    const studio = new V2StudioGraph();
    studio.setSourceBuffer('channel1', [tone(440)]);
    studio.setPan('channel1', -1);
    const out = studio.render(CTX)!;
    const l = out[0].reduce((a, b) => a + Math.abs(b), 0);
    const r = out[1].reduce((a, b) => a + Math.abs(b), 0);
    expect(l).toBeGreaterThan(r * 4);
  });

  it('Master-Gain dämpft den Summenpegel', () => {
    const studio = new V2StudioGraph();
    studio.setSourceBuffer('channel1', [tone(440)]);
    studio.setMasterGain(1);
    const full = studio.render(CTX)![0].reduce((a, b) => a + Math.abs(b), 0);
    studio.setMasterGain(0.1);
    const quiet = studio.render(CTX)![0].reduce((a, b) => a + Math.abs(b), 0);
    expect(quiet).toBeLessThan(full * 0.5);
  });

  it('NaN/Inf im Quellsignal wird im Master geglättet (kein Knacksen)', () => {
    const studio = new V2StudioGraph();
    const bad = tone(440);
    bad[10] = NaN;
    bad[11] = Infinity;
    studio.setSourceBuffer('channel1', [bad]);
    const out = studio.render(CTX)!;
    for (const v of out[0]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('V2-Hybrid-Pfad (GraphEngineAdapter + GraphPlaybackEngine)', () => {
  it('GraphEngineAdapter spiegelt V1-State in den V2-Graph', () => {
    const engine = {
      exportState: () => ({
        version: 1, bpm: 128, swing: 0, gate: 0.9, scale: 'C Minor (Acid)',
        patterns: {}, synthNotes: [], masterVolumeDb: -6, spatialSetupId: '10.0',
        channelGainsDb: { channel1: -6, channel2: 0, channel3: 0, channel4: 0, channel5: 0, channel6: 0, channel7: 0, channel8: 0, channel9: 0, channel10: 0 },
        channelPans: { channel1: -0.5, channel2: 0, channel3: 0, channel4: 0, channel5: 0, channel6: 0, channel7: 0, channel8: 0, channel9: 0, channel10: 0 },
      }),
      importState: () => true,
    };
    const adapter = new GraphEngineAdapter(engine as any);
    const state = adapter.syncToGraph();
    expect(state.channelGainsDb.channel1).toBeCloseTo(-6, 1);
    expect(state.channelPans.channel1).toBeCloseTo(-0.5, 1);
  });

  it('GraphPlaybackEngine rendert Blöcke deterministisch und trigger Impuls', () => {
    let rendered = 0;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bewusst beibehalten (Runde 3)
    const engine = new GraphPlaybackEngine((src, ctx) => {
      rendered++;
      return [src[0].slice()];
    });
    engine.playing = true;
    const out = engine.tick();
    expect(out).not.toBeNull();
    expect(rendered).toBe(1);
    const burst = engine.trigger(0.5);
    expect(burst).not.toBeNull();
  });

  it('WorkletGraphRuntime baut Source→Worklet-Kette ohne Zyklus', () => {
    const rt = new WorkletGraphRuntime();
    rt.registerWorklet({
      id: 'test-gain',
      type: 'gain',
      inputs: 1,
      outputs: 1,
      process: (input, output) => {
        const src = input[0]?.[0];
        const out = output[0];
        for (let i = 0; i < 128; i++) {
          const v = (src?.[i] ?? 0) * 0.5;
          out[0][i] = v;
          out[1][i] = v;
        }
      },
    });
    const result = rt.buildChain(['test-gain'], [tone(440)], CTX);
    expect(result.output).not.toBeNull();
    expect(result.output![0][0]).toBeCloseTo(tone(440)[0] * 0.5, 5);
  });
});
