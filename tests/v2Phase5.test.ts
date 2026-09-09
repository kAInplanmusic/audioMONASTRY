import { describe, expect, it } from 'vitest';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { SourceNode } from '../src/core/audio/nodes/basicNodes';
import {
  DynamicsNode, DspFilterNode, EffectNode, MasteringNode, ParametricEqNode,
} from '../src/core/audio/nodes/processingNodes';
import { V2NodeAutomationCoalescer } from '../src/core/audio/state/v2NodeAutomation';
import { WorkletGraphRuntime } from '../src/core/audio/WorkletGraphRuntime';
import { OfflineBounceEngine } from '../src/audio/bounce/OfflineBounceEngine';
import type { IAudioNode, IProcessingContext } from '../src/core/audio/types';

const SR = 48000;

function tone(freq: number, len = SR / 10): Float32Array {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5;
  return out;
}

function rms(channel: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
  return Math.sqrt(sum / channel.length);
}

function processChain(source: Float32Array[], nodes: IAudioNode[]): Float32Array[] {
  const graph = new AudioGraph();
  const sourceNode = new SourceNode('chain:source', source);
  graph.addNode(sourceNode);
  let output = sourceNode.outputs[0];
  for (const node of nodes) {
    graph.addNode(node);
    graph.connect(output, node.inputs[0]);
    output = node.outputs[0];
  }
  const ctx: IProcessingContext = {
    sampleRate: SR,
    bufferSize: source[0]?.length ?? 128,
    quantum: (source[0]?.length ?? 128) / SR,
    currentTime: 0,
  };
  graph.process(ctx);
  return output.buffer ?? source;
}

describe('Phase 5 · EQ/DSP/Effect/Dynamics/Mastering als V2-Nodes', () => {
  it('ParametricEqNode ist bei 0 dB neutral und boostet mit Low-Shelf-Gain', () => {
    const src = [tone(60, SR / 10)];
    const flat = new ParametricEqNode('eq:flat');
    const boost = new ParametricEqNode('eq:boost');
    boost.setBandGain('low', 12);

    const flatOut = processChain(src, [flat]);
    const boostOut = processChain(src, [boost]);
    expect(rms(flatOut[0])).toBeGreaterThan(0.01);
    expect(rms(boostOut[0])).toBeGreaterThan(rms(flatOut[0]) * 1.4);
  });

  it('DspFilterNode dämpft hohe Frequenzen bei niedrigem Cutoff', () => {
    const src = [tone(5000, SR / 10)];
    const open = new DspFilterNode('dsp:open');
    open.cutoff.setValue(20000);
    const closed = new DspFilterNode('dsp:closed');
    closed.cutoff.setValue(300);

    const openOut = processChain(src, [open]);
    const closedOut = processChain(src, [closed]);
    expect(rms(closedOut[0])).toBeLessThan(rms(openOut[0]) * 0.6);
  });

  it('EffectNode erzeugt Nachklang (Reverb/Delay-Tail)', () => {
    const impulse = new Float32Array(256);
    impulse[0] = 1;
    const effect = new EffectNode('fx');
    effect.wet.setValue(0.8);
    effect.feedback.setValue(0.5);
    const result = new OfflineBounceEngine(SR).bounceNodeChain(
      [impulse],
      [effect],
      { tailSeconds: 0.2 },
    );
    const tail = result.output[0].subarray(impulse.length);
    expect(rms(tail)).toBeGreaterThan(1e-4);
  });

  it('DynamicsNode komprimiert lautes Material messbar', () => {
    const src = [new Float32Array(SR / 10).fill(0.9)];
    const bypass = new DynamicsNode('dyn:off');
    bypass.setEnabled(false);
    const comp = new DynamicsNode('dyn:on');
    comp.threshold.setValue(-40);
    comp.ratio.setValue(20);
    comp.knee.setValue(0);
    comp.attack.setValue(0.001);
    comp.release.setValue(0.2);

    const bypassOut = processChain(src, [bypass]);
    const compOut = processChain(src, [comp]);
    expect(rms(compOut[0])).toBeLessThan(rms(bypassOut[0]) * 0.5);
  });

  it('MasteringNode respektiert das Ceiling', () => {
    const src = [new Float32Array(SR / 10).fill(1.0)];
    const mastering = new MasteringNode('master');
    mastering.ceiling.setValue(0.5);
    mastering.ratio.setValue(4);
    mastering.makeup.setValue(1);
    const out = processChain(src, [mastering])[0];
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeLessThanOrEqual(0.51);
    }
  });
});

describe('Phase 5 · Parameter-Automation (Coalescer) an V2-Nodes', () => {
  it('bündelt Updates und wendet sie nach flushNow auf den Node an', () => {
    const eq = new ParametricEqNode('eq:auto');
    const nodes = new Map([['eq:auto', eq]]);
    const auto = new V2NodeAutomationCoalescer(nodes, { intervalMs: 1000 });
    expect(eq.getParameter('low')?.value).toBe(0);
    auto.push('eq:auto', 'low', -9);
    auto.push('eq:auto', 'high', 4);
    expect(eq.getParameter('low')?.value).toBe(0); // noch nicht geflusht
    auto.flushNow();
    expect(eq.getParameter('low')?.value).toBe(-9);
    expect(eq.getParameter('high')?.value).toBe(4);
  });
});

describe('Phase 5 · WorkletChain + Offline-Bounce über denselben V2-Graph', () => {
  it('WorkletGraphRuntime.buildChainGraph liefert verdrahtbaren Graph', () => {
    const rt = new WorkletGraphRuntime();
    rt.registerWorklet({
      id: 'gain-x2',
      type: 'gain',
      inputs: 1,
      outputs: 1,
      process: (input, output) => {
        const src = input[0]?.[0] ?? new Float32Array(128);
        const out = output[0];
        for (let i = 0; i < out[0].length; i++) out[0][i] = (src[i] ?? 0) * 2;
      },
    });
    const source = [new Float32Array(128).fill(0.25)];
    const chain = rt.buildChainGraph(['gain-x2'], source);
    const ctx: IProcessingContext = { sampleRate: SR, bufferSize: 128, quantum: 128 / SR, currentTime: 0 };
    chain.graph.process(ctx);
    expect(chain.output.buffer![0][0]).toBeCloseTo(0.5, 5);
  });

  it('OfflineBounceEngine.bounceNodeChain ist deterministisch', () => {
    const engine = new OfflineBounceEngine(SR);
    const source = [tone(440, 1000)];
    const makeNodes = () => [
      new ParametricEqNode('bounce:eq'),
      new DspFilterNode('bounce:dsp'),
      new MasteringNode('bounce:master'),
    ];
    const a = engine.bounceNodeChain(source, makeNodes(), { tailSeconds: 0.05 });
    const b = engine.bounceNodeChain(source, makeNodes(), { tailSeconds: 0.05 });
    expect(a.output[0].length).toBe(b.output[0].length);
    expect(Buffer.from(a.output[0].buffer).equals(Buffer.from(b.output[0].buffer))).toBe(true);
  });
});
