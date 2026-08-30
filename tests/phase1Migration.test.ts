import { describe, expect, it } from 'vitest';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { BufferPool } from '../src/core/audio/BufferPool';
import { GraphStateBridge } from '../src/core/audio/GraphStateBridge';
import { WorkletProcessorAdapter } from '../src/core/audio/backends/WorkletAdapter';
import { WorkletGraphRuntime } from '../src/core/audio/WorkletGraphRuntime';
import { registerReferenceWorkletSpecs } from '../src/core/audio/workletSpecs';
import { WebAudioBackend } from '../src/core/audio/backends/WebAudioBackend';
import { GainNode, SourceNode, StereoPanNode, ThreeBandEqNode } from '../src/core/audio/nodes/basicNodes';
import { emptyAudioGraphState } from '../src/utils/audioGraphSerialization';

const ctx = { sampleRate: 48000, bufferSize: 8, currentTime: 0, quantum: 8 / 48000 };

describe('Phase 1, Schritt 1 – GraphStateBridge', () => {
  it('import/export Round-Trip erhält Gain/Pan-Werte', () => {
    const state = emptyAudioGraphState();
    state.channelGainsDb = { channel1: -6, channel2: 3 };
    state.channelPans = { channel1: -0.5, channel2: 0.5 };

    const bridge = new GraphStateBridge();
    bridge.importState(state);
    const exported = bridge.exportState(state);

    expect(exported.channelGainsDb.channel1).toBeCloseTo(-6, 5);
    expect(exported.channelGainsDb.channel2).toBeCloseTo(3, 5);
    expect(exported.channelPans.channel1).toBeCloseTo(-0.5, 5);
    expect(exported.channelPans.channel2).toBeCloseTo(0.5, 5);
    expect(bridge.graph.compile().validated).toBe(true);
  });
});

describe('Phase 1, Schritt 2 – Mixer-Kette als IAudioNode', () => {
  it('Source → Gain → Pan verarbeitet deterministisch', () => {
    const graph = new AudioGraph();
    const src = new SourceNode('src', [new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]), new Float32Array([1, 1, 1, 1, 1, 1, 1, 1])]);
    const gain = new GainNode('gain', 0.5);
    const pan = new StereoPanNode('pan', 0);
    graph.addNode(src);
    graph.addNode(gain);
    graph.addNode(pan);
    graph.connect(src.outputs[0], gain.inputs[0]);
    graph.connect(gain.outputs[0], pan.inputs[0]);

    graph.process(ctx);
    const out = pan.outputs[0].buffer;
    expect(out).not.toBeNull();
    expect(out![0][0]).toBeCloseTo(0.5 * Math.SQRT1_2, 5);
  });

  it('3-Band-EQ reicht Signale durch (lineare Mischung)', () => {
    const graph = new AudioGraph();
    const src = new SourceNode('src', [new Float32Array([0.5, 0.5])]);
    const eq = new ThreeBandEqNode('eq', 0, 0, 0);
    graph.addNode(src);
    graph.addNode(eq);
    graph.connect(src.outputs[0], eq.inputs[0]);
    graph.process(ctx);
    expect(eq.outputs[0].buffer![0][0]).toBeCloseTo(0.5, 5);
  });
});

describe('Phase 1, Schritt 3 – Worklet-Adapter + Optimierung', () => {
  it('WorkletProcessorAdapter bindet Prozessoren an den Plan', () => {
    const graph = new AudioGraph();
    const src = new SourceNode('src', [new Float32Array([1, 1])]);
    const worklet = new WorkletProcessorAdapter('worklet', 'gain-x2', (input, output) => {
      const inp = input[0]?.[0] ?? new Float32Array(2);
      const out = output[0];
      for (let i = 0; i < 2; i++) out[0][i] = inp[i] * 2;
    });
    graph.addNode(src);
    graph.addNode(worklet);
    graph.connect(src.outputs[0], worklet.inputs[0]);
    graph.process(ctx);
    expect(worklet.outputs[0].buffer![0][0]).toBeCloseTo(2, 5);
  });

  it('BufferPool wiederverwendet Buffer statt neu zu allokieren', () => {
    const pool = new BufferPool();
    const a = pool.acquire(2, 128);
    pool.release(a);
    const b = pool.acquire(2, 128);
    expect(b[0]).toBe(a[0]);
    expect(pool.getStats().acquired).toBe(2);
  });
});

describe('Phase 1, Schritt 3b – WorkletGraphRuntime (Kette itSynth → EQ → Mastering)', () => {
  it('verkettet registrierte Worklets zu einem ProcessingPlan', () => {
    const rt = new WorkletGraphRuntime();
    rt.registerWorklet({
      id: 'it-synth', type: 'itSynthProcessor', inputs: 1, outputs: 1,
      process: (input, output) => { const src = input[0]?.[0]; const out = output[0][0]; for (let i = 0; i < out.length; i++) out[i] = (src?.[i] ?? 0) * 2; },
    });
    rt.registerWorklet({
      id: 'eq3', type: 'eqProcessor', inputs: 1, outputs: 1,
      process: (input, output) => { const src = input[0]?.[0]; const out = output[0][0]; for (let i = 0; i < out.length; i++) out[i] = (src?.[i] ?? 0) + 0.5; },
    });
    rt.registerWorklet({
      id: 'mastering', type: 'masteringProcessor', inputs: 1, outputs: 1,
      process: (input, output) => { const src = input[0]?.[0]; const out = output[0][0]; for (let i = 0; i < out.length; i++) out[i] = (src?.[i] ?? 0) * 2; },
    });

    const res = rt.buildChain(['it-synth', 'eq3', 'mastering'], [new Float32Array([1, 1])], ctx);
    expect(res.graph.compile().validated).toBe(true);
    expect(res.output![0][0]).toBeCloseTo((1 * 2 + 0.5) * 2, 5);
    expect(rt.listWorklets()).toEqual(['it-synth', 'eq3', 'mastering']);
  });

  it('Referenz-Specs (itSynth/EQ/Mastering) sind registrierbar und verarbeiten deterministisch', () => {
    const rt = new WorkletGraphRuntime();
    registerReferenceWorkletSpecs(rt);
    const res = rt.buildChain(['it-synth', 'eq3', 'mastering'], [new Float32Array([0.9, -0.9])], ctx);
    expect(res.graph.compile().validated).toBe(true);
    // itSynth: pass-through, eq3: pass-through, mastering: tanh(0.9)
    expect(res.output![0][0]).toBeCloseTo(Math.tanh(0.9), 5);
    expect(res.output![0][1]).toBeCloseTo(Math.tanh(-0.9), 5);
  });

  it('WebAudioBackend.render kopiert Graph-Output in den Ziel-Buffer', async () => {
    const backend = new WebAudioBackend();
    const graph = new AudioGraph();
    const src = new SourceNode('src', [new Float32Array([0.25, 0.5])]);
    graph.addNode(src);

    const output = backend.createBuffer(48000, 2, 1);
    await backend.render(graph, ctx, output);
    expect(output.channelData[0][0]).toBeCloseTo(0.25, 5);
    expect(output.channelData[0][1]).toBeCloseTo(0.5, 5);
  });
});
