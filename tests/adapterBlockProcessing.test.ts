import { describe, expect, it } from 'vitest';

import { EffectPluginAdapter } from '../src/plugins/adapters/EffectPluginAdapter';
import { MasterPluginAdapter } from '../src/plugins/adapters/MasterPluginAdapter';
import type { PluginInterface, PluginParameterValue } from '../src/plugins/plugin_interface';
import type { PluginState } from '../src/plugins/types';

const SR = 8000;

/** Deterministische Quelle (kein Rauschen) für bit-genaue Vergleiche. */
function channelsOf(frames: number, count = 1): Float32Array[] {
  return Array.from({ length: count }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => Math.sin((i + c) / 5) * 0.8),
  );
}

type Params = Record<string, PluginParameterValue['value']>;

/** Setzt Zustand/Parameter deterministisch und schickt EINEN Block durch. */
function runBlock(
  adapter: PluginInterface,
  params: Params = {},
  state: PluginState = 'PRO',
  frames = 64,
  count = 1,
): Float32Array[] {
  adapter.restore({ pluginId: adapter.manifest.id, state, parameters: params });
  const block = adapter.process({
    channels: channelsOf(frames, count),
    sampleRate: SR,
    timestamp: 0,
    frameCount: frames,
  });
  return block.channels as Float32Array[];
}

describe('Adapter-Blockverarbeitung: effect (Bit-Tiefe + Dry/Wet)', () => {
  it('ist bei voller Bit-Tiefe transparent', () => {
    const adapter = new EffectPluginAdapter();
    const src = channelsOf(64);
    const out = runBlock(adapter, {}, 'PRO');
    expect(Array.from(out[0])).toEqual(Array.from(src[0]));
  });

  it('ist bei OFF transparent, auch mit niedriger Bit-Tiefe', () => {
    const adapter = new EffectPluginAdapter();
    const src = channelsOf(64);
    const out = runBlock(adapter, { bits: 3 }, 'OFF');
    expect(Array.from(out[0])).toEqual(Array.from(src[0]));
  });

  it('quantisiert bei bits=4 auf Achtel-Schritte', () => {
    const adapter = new EffectPluginAdapter();
    const src = channelsOf(64);
    const out = runBlock(adapter, { bits: 4, wet: 1 });
    for (let i = 0; i < 64; i++) {
      expect(out[0][i]).toBeCloseTo(Math.round(src[0][i] * 8) / 8, 6);
      expect(out[0][i] * 8).toBeCloseTo(Math.round(out[0][i] * 8), 6); // Vielfaches von 1/8
    }
    expect(Array.from(out[0])).not.toEqual(Array.from(src[0]));
  });

  it('laesst bei wet=0 das trockene Signal stehen', () => {
    const adapter = new EffectPluginAdapter();
    const src = channelsOf(64);
    const out = runBlock(adapter, { bits: 4, wet: 0 });
    expect(Array.from(out[0])).toEqual(Array.from(src[0]));
  });

  it('klemmt bits auf 1…16', () => {
    const adapter = new EffectPluginAdapter();
    const src = channelsOf(16);
    // 99 -> 16 -> transparent
    expect(Array.from(runBlock(adapter, { bits: 99 }, 'PRO', 16)[0])).toEqual(Array.from(src[0]));
    // -3 -> 1 -> Stufen von 1.0 (alles auf -1/0/1 gerundet)
    const crushed = runBlock(adapter, { bits: -3, wet: 1 }, 'PRO', 16)[0];
    for (let i = 0; i < 16; i++) {
      expect(crushed[i]).toBeCloseTo(Math.round(src[0][i]), 6);
    }
  });

  it('arbeitet auf allen Kanaelen', () => {
    const adapter = new EffectPluginAdapter();
    const out = runBlock(adapter, { bits: 4, wet: 1 }, 'PRO', 32, 2);
    expect(out.length).toBe(2);
    for (const channel of out) {
      for (let i = 0; i < 32; i++) {
        expect(channel[i] * 8).toBeCloseTo(Math.round(channel[i] * 8), 6);
      }
    }
  });
});

describe('Adapter-Blockverarbeitung: master (Ausgangsverstaerkung)', () => {
  it('ist ohne Parameter transparent', () => {
    const adapter = new MasterPluginAdapter();
    const src = channelsOf(32);
    expect(Array.from(runBlock(adapter, {}, 'PRO', 32)[0])).toEqual(Array.from(src[0]));
  });

  it('halbiert bei gain=0.5', () => {
    const adapter = new MasterPluginAdapter();
    const src = channelsOf(32);
    const out = runBlock(adapter, { gain: 0.5 })[0];
    for (let i = 0; i < 32; i++) expect(out[i]).toBeCloseTo(src[0][i] * 0.5, 6);
  });

  it('klemmt gain auf 0…2', () => {
    const adapter = new MasterPluginAdapter();
    const src = channelsOf(16);
    const doubled = runBlock(adapter, { gain: 5 })[0];
    for (let i = 0; i < 16; i++) expect(doubled[i]).toBeCloseTo(src[0][i] * 2, 6);

    const silent = runBlock(adapter, { gain: -1 })[0];
    for (let i = 0; i < 16; i++) expect(silent[i]).toBe(0);
  });
});
