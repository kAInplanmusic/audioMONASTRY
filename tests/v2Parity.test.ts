import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { GraphStateBridge } from '../src/core/audio/GraphStateBridge';
import { emptyAudioGraphState } from '../src/utils/audioGraphSerialization';
import { OfflineBounceEngine } from '../src/audio/bounce/OfflineBounceEngine';
import { workletGraphRuntime } from '../src/core/audio/WorkletGraphRuntime';
import { registerReferenceWorkletSpecs, REFERENCE_WORKLET_IDS } from '../src/core/audio/workletSpecs';
import { ParametricEqNode, MasteringNode } from '../src/core/audio/nodes/processingNodes';

const SR = 48000;

function tone(freq: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5;
  return out;
}

function rms(channel: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
  return Math.sqrt(sum / channel.length);
}

function sha256(channel: Float32Array): string {
  return createHash('sha256').update(Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength)).digest('hex');
}

registerReferenceWorkletSpecs(workletGraphRuntime);

describe('Phase 8 · V1↔V2 Paritätstest (VISIONS B8)', () => {
  it('GraphStateBridge: V1-State → V2-Graph → zurück ist für alle 10 Kanäle identisch', () => {
    const state = emptyAudioGraphState();
    state.channelGainsDb = {
      channel1: -6, channel2: -3, channel3: 0, channel4: 2,
      channel5: -1, channel6: 3, channel7: -2, channel8: 0,
      channel9: 4, channel10: -5,
    };
    state.channelPans = {
      channel1: -0.75, channel2: 0.5, channel3: 0, channel4: -0.25,
      channel5: 1, channel6: -1, channel7: 0.25, channel8: 0,
      channel9: 0.6, channel10: -0.4,
    };

    const bridge = new GraphStateBridge();
    bridge.importState(state);
    const exported = bridge.exportState(state);

    for (const track of Object.keys(state.channelGainsDb)) {
      expect(exported.channelGainsDb[track]).toBeCloseTo(state.channelGainsDb[track], 4);
    }
    for (const track of Object.keys(state.channelPans)) {
      expect(exported.channelPans[track]).toBeCloseTo(state.channelPans[track], 4);
    }
    expect(bridge.graph.compile().validated).toBe(true);
  });

  it('V1-Referenz-Worklet-Kette und V2-Node-Kette sind deterministisch und hörbar (A/B-Proxy)', () => {
    const source = [tone(440, 0.5), tone(554.37, 0.5)];
    const engine = new OfflineBounceEngine(SR);

    // A: V1-Referenz (it-synth → eq3 → mastering), wie im Golden-Master.
    const referenceA = engine.bounce(source, [...REFERENCE_WORKLET_IDS], { tailSeconds: 0 });
    // B: V2-Graph (flaches EQ + Mastering-Node).
    const v2Nodes = [
      new ParametricEqNode('parity:eq'),
      new MasteringNode('parity:mastering'),
    ];
    const referenceB = engine.bounceNodeChain(source, v2Nodes, { tailSeconds: 0 });

    const rmsA = rms(referenceA.output[0]);
    const rmsB = rms(referenceB.output[0]);

    // Beide Pfade liefern hörbares Material (kein Stille-/Routing-Regress).
    expect(rmsA).toBeGreaterThan(0.01);
    expect(rmsB).toBeGreaterThan(0.01);
    // A/B-Proxy: Pegel liegen in derselben Größenordnung (± breite Toleranz,
    // da V1-Mastering tanh-Limiter vs. V2-Mastering-Node unterschiedlich färben).
    const ratio = Math.max(rmsA, rmsB) / Math.max(1e-6, Math.min(rmsA, rmsB));
    expect(ratio).toBeLessThan(20);
  });

  it('A/B-Proxy ist wiederholbar (bit-identische Hashes)', () => {
    const source = [tone(220, 0.25), tone(330, 0.25)];
    const engine = new OfflineBounceEngine(SR);
    const makeNodes = () => [new ParametricEqNode('ab:eq'), new MasteringNode('ab:master')];

    const b1 = engine.bounceNodeChain(source, makeNodes(), { tailSeconds: 0 });
    const b2 = engine.bounceNodeChain(source, makeNodes(), { tailSeconds: 0 });
    expect(sha256(b1.output[0])).toBe(sha256(b2.output[0]));

    const a1 = engine.bounce(source, [...REFERENCE_WORKLET_IDS], { tailSeconds: 0 });
    const a2 = engine.bounce(source, [...REFERENCE_WORKLET_IDS], { tailSeconds: 0 });
    expect(sha256(a1.output[0])).toBe(sha256(a2.output[0]));
  });
});
