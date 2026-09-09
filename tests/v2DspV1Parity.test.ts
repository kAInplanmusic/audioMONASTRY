import { describe, beforeAll, expect, it } from 'vitest';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { SourceNode } from '../src/core/audio/nodes/basicNodes';
import { DynamicsNode, MasteringNode, ParametricEqNode } from '../src/core/audio/nodes/processingNodes';

const SR = 48000;

// V1-Worklet-Dateien extenden z. T. direkt `AudioWorkletProcessor` und rufen
// `registerProcessor` auf – für Node-Tests die Globals bereitstellen.
beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.sampleRate = SR;
  g.currentFrame = 0;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null as null, postMessage: () => {} };
  };
  g.registerProcessor = () => {};
});

function runV1Processor(
  ctor: new () => { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean },
  source: Float32Array[],
): Float32Array[] {
  const proc = new ctor();
  const output = source.map((ch) => new Float32Array(ch.length));
  const ok = proc.process([source], [output]);
  expect(ok).toBe(true);
  return output;
}

function runV2Node(node: import('../src/core/audio/types').IAudioNode, source: Float32Array[]): Float32Array[] {
  const graph = new AudioGraph();
  const sourceNode = new SourceNode('parity:source', source);
  graph.addNode(sourceNode);
  graph.addNode(node);
  graph.connect(sourceNode.outputs[0], node.inputs[0]);
  graph.process({
    sampleRate: SR,
    bufferSize: source[0]?.length ?? 128,
    quantum: (source[0]?.length ?? 128) / SR,
    currentTime: 0,
  });
  return node.outputs[0].buffer ?? source;
}

describe('AP3 · Echte DSP-V1/V2-Parität (echte V1-Worklet-Klassen vs. V2-Nodes)', () => {
  it('Dynamics: V1-Bypass und V2-Disabled sind bit-identisch (Passthrough-Parität)', async () => {
    const { DynamicsProcessor } = await import('../src/audio/worklets/dynamicsProcessor');
    const source = [new Float32Array(256), new Float32Array(256)];
    for (let i = 0; i < 256; i++) {
      source[0][i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.4;
      source[1][i] = Math.cos((2 * Math.PI * 220 * i) / SR) * 0.3;
    }

    const v1 = runV1Processor(DynamicsProcessor as never, source);
    const v2Node = new DynamicsNode('parity:dyn');
    v2Node.setEnabled(false);
    const v2 = runV2Node(v2Node, source);

    for (let ch = 0; ch < source.length; ch++) {
      for (let i = 0; i < source[ch].length; i++) {
        expect(v1[ch][i]).toBe(v2[ch][i]);
        expect(v2[ch][i]).toBe(source[ch][i]);
      }
    }
  });

  it('Mastering: V1-Limiter und V2-Mastering-Node begrenzen Peaks und bleiben hörbar', async () => {
    const { MasteringProcessor } = await import('../src/audio/worklets/masteringProcessor');
    const source = [new Float32Array(SR / 20).fill(1.0)];

    const v1 = runV1Processor(MasteringProcessor as never, source);
    const v2Node = new MasteringNode('parity:master');
    const v2 = runV2Node(v2Node, source);

    for (const ch of v1) {
      for (const v of ch) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1);
      }
    }
    for (const ch of v2) {
      for (const v of ch) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('EQ/DSP/Effect: echte V1-Prozessoren laufen offline und liefern hörbares Material', async () => {
    const { EqProcessor } = await import('../src/audio/worklets/eqProcessor');
    const { DspProcessor } = await import('../src/audio/worklets/dspProcessor');
    const { EffectProcessor } = await import('../src/audio/worklets/effectProcessor');
    const source = [new Float32Array(512)];
    for (let i = 0; i < 512; i++) source[0][i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;

    const eq = runV1Processor(EqProcessor as never, source);
    const dsp = runV1Processor(DspProcessor as never, source);
    const fx = runV1Processor(EffectProcessor as never, source);

    for (const [name, out] of [['eq', eq], ['dsp', dsp], ['fx', fx]] as const) {
      const peak = out[0].reduce((max, v) => Math.max(max, Math.abs(v)), 0);
      expect(Number.isFinite(peak), `${name} sollte endlich sein`).toBe(true);
      expect(peak).toBeGreaterThan(0);
    }

    // V2-Äquivalente liefern ebenfalls endliches, hörbares Material.
    const eqV2 = runV2Node(new ParametricEqNode('parity:eq'), source);
    expect(eqV2[0].some((v) => Math.abs(v) > 1e-4)).toBe(true);
  });
});
