import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createSeededRandom } from '../src/utils/random';
import { isAudioGraphState, emptyAudioGraphState } from '../src/utils/audioGraphSerialization';
import { AudioGraph } from '../src/core/audio/AudioGraph';
import { GainNode } from '../src/core/audio/nodes/basicNodes';
import { registerReferenceWorkletSpecs, REFERENCE_WORKLET_IDS } from '../src/core/audio/workletSpecs';
import { workletGraphRuntime } from '../src/core/audio/WorkletGraphRuntime';
import { OfflineBounceEngine } from '../src/audio/bounce/OfflineBounceEngine';

function sha256(buf: Float32Array): string {
  return createHash('sha256').update(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)).digest('hex');
}

describe('DSP-Qualität: deterministischer PRNG', () => {
  it('gleicher Seed liefert identische Sequenz, anderer Seed nicht', () => {
    const a = createSeededRandom(0xA11CE5EED);
    const b = createSeededRandom(0xA11CE5EED);
    const c = createSeededRandom(1);
    const seqA = Array.from({ length: 16 }, () => a());
    const seqB = Array.from({ length: 16 }, () => b());
    const seqC = Array.from({ length: 16 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });
});

describe('DSP-Qualität: State-Hygiene (32-Step-Fix)', () => {
  it('akzeptiert 16- und 32-Step-States, lehnt 8-Step ab', () => {
    const base = emptyAudioGraphState() as unknown as Record<string, unknown>;
    const s16 = { ...base, patterns: Object.fromEntries(Object.entries(base.patterns as Record<string, unknown>).map(([k]) => [k, Array(16).fill(false)])), synthNotes: Array(16).fill(0) };
    const s32 = { ...base, patterns: Object.fromEntries(Object.entries(base.patterns as Record<string, unknown>).map(([k]) => [k, Array(32).fill(false)])), synthNotes: Array(32).fill(0) };
    const sBad = { ...base, synthNotes: Array(8).fill(0) };
    expect(isAudioGraphState(s16)).toBe(true);
    expect(isAudioGraphState(s32)).toBe(true);
    expect(isAudioGraphState(sBad)).toBe(false);
  });
});

describe('DSP-Qualität: AudioGraph-Compile-Caching', () => {
  it('compile() cached den Plan und invalidiert bei Topologie-Änderung', () => {
    const graph = new AudioGraph();
    const a = new GainNode('a', 1);
    const b = new GainNode('b', 1);
    graph.addNode(a);
    graph.addNode(b);
    graph.connect(a.outputs[0], b.inputs[0]);
    const plan1 = graph.compile();
    const plan2 = graph.compile();
    expect(plan1).toBe(plan2); // gleiche Instanz -> Cache

    const c = new GainNode('c', 1);
    graph.addNode(c);
    const plan3 = graph.compile();
    expect(plan3).not.toBe(plan1);
    expect(plan3.order.length).toBe(3);
    // Topologische Ordnung: 'b' haengt von 'a' ab und muss danach kommen.
    expect(plan3.order.indexOf('b')).toBeGreaterThan(plan3.order.indexOf('a'));
  });
});

describe('DSP-Qualität: deterministischer Offline-Bounce mit Tail', () => {
  it('zwei identische Bounces sind bit-identisch und der Tail wird angehängt', () => {
    registerReferenceWorkletSpecs(workletGraphRuntime);
    const engine = new OfflineBounceEngine(48000);
    const frames = 1000;
    const source = [new Float32Array(frames)];
    for (let i = 0; i < frames; i++) source[0][i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;

    const ids = [...REFERENCE_WORKLET_IDS];
    const r1 = engine.bounce(source, ids, { tailSeconds: 2 });
    const r2 = engine.bounce(source, ids, { tailSeconds: 2 });

    expect(r1.tailFrames).toBe(2 * 48000);
    expect(r1.output[0].length).toBe(frames + 2 * 48000);
    expect(sha256(r1.output[0])).toBe(sha256(r2.output[0]));

    // Tail muss Stille sein (Quellmaterial endet bei `frames`, Kette ist zustandslos).
    const tail = r1.output[0].subarray(frames);
    let tailEnergy = 0;
    for (let i = 0; i < tail.length; i++) tailEnergy += tail[i] * tail[i];
    expect(Math.sqrt(tailEnergy / tail.length)).toBeLessThan(1e-7);
  });

  it('wirft bei nicht registriertem Worklet', () => {
    const engine = new OfflineBounceEngine();
    expect(() => engine.bounce([new Float32Array(128)], ['gibt-es-nicht'])).toThrow(/nicht registriert/);
  });
});
