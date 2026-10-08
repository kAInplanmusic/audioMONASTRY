import { describe, expect, it } from 'vitest';

import { bounceThroughPluginChain } from '../src/audio/pluginChainBounce';
import { createPluginAdapters } from '../src/plugins/adapters';
import { BasePluginAdapter } from '../src/plugins/adapters/BasePluginAdapter';
import { SIGNAL_CHAIN_ORDER } from '../src/plugins/signalChain';
import type {
  CanonicalPluginId,
  PluginAudioBlock,
  PluginSnapshot,
} from '../src/plugins/plugin_interface';
import type { PluginState } from '../src/plugins/types';

const SR = 8000;

/** Deterministische Quelle: kein Rauschen, damit Vergleiche bit-genau sind. */
function source(frames: number, channels = 1): Float32Array[] {
  return Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => Math.sin((i + c) / 7) * 0.5),
  );
}

const masterGain = (gain: number): PluginSnapshot[] => [
  { pluginId: 'master', state: 'PRO', parameters: { gain } },
];

/**
 * Test-Adapter mit frei wählbarer, nicht-kommutierender Wirkung – nur für den
 * Ordnungsbeweis. `calls` protokolliert die Aufrufreihenfolge.
 */
class TransformAdapter extends BasePluginAdapter {
  constructor(
    private readonly pluginId: CanonicalPluginId,
    private readonly fn: (value: number) => number,
    state: PluginState,
    private readonly calls: string[] = [],
  ) {
    super({
      id: pluginId,
      name: `${pluginId}MONK`,
      version: '1.0.0',
      kind: 'audio-processor',
      capabilities: ['audio-processor'],
      latencySamples: 0,
      tailSamples: 0,
    });
    this.state = state;
  }

  protected override onProcess(block: PluginAudioBlock): PluginAudioBlock {
    this.calls.push(this.pluginId);
    for (const channel of block.channels) {
      for (let i = 0; i < channel.length; i++) channel[i] = this.fn(channel[i]);
    }
    return block;
  }
}

describe('Bounce durch die Signalkette', () => {
  it('ist bei OFF ein transparenter Bypass (bit-gleich)', async () => {
    const src = source(300);
    const res = await bounceThroughPluginChain(src, { sampleRate: SR });
    expect(res.output[0].length).toBe(300);
    expect(Array.from(res.output[0])).toEqual(Array.from(src[0]));
  });

  it('verarbeitet in der Reihenfolge der Signalkette', async () => {
    const res = await bounceThroughPluginChain(source(64), { sampleRate: SR });
    expect(res.order).toEqual(SIGNAL_CHAIN_ORDER);
    expect(res.order.indexOf('mixer')).toBeGreaterThan(res.order.indexOf('syntisampler'));
  });

  it('haengt den Tail als Stille an', async () => {
    const res = await bounceThroughPluginChain(source(100), { sampleRate: SR, tailSeconds: 0.5 });
    expect(res.tailFrames).toBe(4000);
    expect(res.renderedFrames).toBe(4100);
    expect(res.output[0].subarray(100).every((v) => v === 0)).toBe(true);
  });

  it('wendet den Master-Gain aus dem Snapshot an', async () => {
    const src = source(200);
    const res = await bounceThroughPluginChain(src, { sampleRate: SR, snapshots: masterGain(0.5) });
    for (let i = 0; i < 200; i++) {
      expect(res.output[0][i]).toBeCloseTo(src[0][i] * 0.5, 6);
    }
  });

  it('klemmt den Master-Gain auf 0…2', async () => {
    const src = source(16);
    const res = await bounceThroughPluginChain(src, { sampleRate: SR, snapshots: masterGain(99) });
    for (let i = 0; i < 16; i++) {
      expect(res.output[0][i]).toBeCloseTo(src[0][i] * 2, 6);
    }
  });

  it('ist unabhaengig von der Blockgroesse (keine Blockgrenzen-Artefakte)', async () => {
    const src = source(777, 2);
    const small = await bounceThroughPluginChain(src, { sampleRate: SR, blockSize: 32, snapshots: masterGain(0.25) });
    const big = await bounceThroughPluginChain(src, { sampleRate: SR, blockSize: 1000, snapshots: masterGain(0.25) });
    expect(Array.from(small.output[0])).toEqual(Array.from(big.output[0]));
    expect(Array.from(small.output[1])).toEqual(Array.from(big.output[1]));
    expect(small.renderedFrames).toBe(777);
  });

  it('laesst die Quelle unangetastet (der Cache darf nicht leiden)', async () => {
    const src = source(64);
    const before = Array.from(src[0]);
    await bounceThroughPluginChain(src, { sampleRate: SR, snapshots: masterGain(0.1) });
    expect(Array.from(src[0])).toEqual(before);
  });

  it('verarbeitet beide Kanaele getrennt und gleich', async () => {
    const src = source(128, 2);
    const res = await bounceThroughPluginChain(src, { sampleRate: SR, snapshots: masterGain(0.5) });
    expect(res.output.length).toBe(2);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < 128; i++) {
        expect(res.output[c][i]).toBeCloseTo(src[c][i] * 0.5, 6);
      }
    }
  });

  it('kommt mit einer leeren Quelle klar', async () => {
    const res = await bounceThroughPluginChain([], { sampleRate: SR });
    expect(res.renderedFrames).toBe(0);
    expect(res.output).toEqual([]);
  });

  /**
   * Der eigentliche Ordnungsbeweis: zwei Adapter mit nicht-kommutierender
   * Wirkung. `effect` (Position 10) addiert 1, `master` (Position 14)
   * verdoppelt. In Kettenreihenfolge ergibt das (x+1)*2 = 2x+2.
   * Umgekehrte Reihenfolge ergäbe 2x+1 – der Test würde ihn unterscheiden.
   */
  it('wirkt in der Kettenreihenfolge (effect vor master)', async () => {
    const adapters = createPluginAdapters();
    const calls: string[] = [];
    adapters.effect = new TransformAdapter('effect', (v) => v + 1, 'PRO', calls);
    adapters.master = new TransformAdapter('master', (v) => v * 2, 'PRO', calls);

    const src = source(64);
    const res = await bounceThroughPluginChain(src, { sampleRate: SR, adapters });

    expect(calls).toEqual(['effect', 'master']);
    for (let i = 0; i < 64; i++) {
      expect(res.output[0][i]).toBeCloseTo((src[0][i] + 1) * 2, 6);
    }
  });

  it('ueberspringt OFF-Plugins auch im Bounce', async () => {
    const adapters = createPluginAdapters();
    adapters.effect = new TransformAdapter('effect', (v) => v + 1, 'OFF');
    const src = source(32);
    const res = await bounceThroughPluginChain(src, { sampleRate: SR, adapters });
    expect(Array.from(res.output[0])).toEqual(Array.from(src[0]));
  });

  it('aendert das Ergebnis nicht, wenn zwischendurch an die Event-Loop abgegeben wird', async () => {
    const src = source(700, 2);
    const options = { sampleRate: SR, blockSize: 128, snapshots: masterGain(0.5) };
    const sync = await bounceThroughPluginChain(src, { ...options, yieldEveryBlocks: 0 });
    const yielded = await bounceThroughPluginChain(src, { ...options, yieldEveryBlocks: 1 });
    expect(Array.from(yielded.output[0])).toEqual(Array.from(sync.output[0]));
    expect(Array.from(yielded.output[1])).toEqual(Array.from(sync.output[1]));
  });
});
