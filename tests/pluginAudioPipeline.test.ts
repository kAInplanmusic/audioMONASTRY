import { describe, expect, it } from 'vitest';
import { createPluginAdapters, CANONICAL_PLUGIN_IDS } from '../src/plugins/adapters';
import { PluginAudioPipeline } from '../src/audio/PluginAudioPipeline';
import type { PluginAudioBlock } from '../src/plugins/plugin_interface';

const BLOCK: PluginAudioBlock = {
  channels: [new Float32Array([0.1, 0.2, 0.3, 0.4])],
  sampleRate: 48000,
  timestamp: 0,
  frameCount: 4,
};

describe('PluginAudioPipeline', () => {
  it('verarbeitet Plugins in deterministischer Reihenfolge', () => {
    const adapters = createPluginAdapters();
    const calls: string[] = [];
    for (const id of CANONICAL_PLUGIN_IDS) {
      const original = adapters[id].process.bind(adapters[id]);
      (adapters[id] as { process: (b: PluginAudioBlock) => PluginAudioBlock }).process = (b) => {
        calls.push(id);
        return original(b);
      };
      adapters[id].setState('PRO');
    }
    const pipeline = new PluginAudioPipeline(adapters, CANONICAL_PLUGIN_IDS);
    pipeline.process(BLOCK);
    expect(calls).toEqual([...CANONICAL_PLUGIN_IDS]);
  });

  it('überspringt OFF-Plugins und ruft aktive genau einmal auf', () => {
    const adapters = createPluginAdapters();
    let calls = 0;
    const original = adapters.mixer.process.bind(adapters.mixer);
    (adapters.mixer as { process: (b: PluginAudioBlock) => PluginAudioBlock }).process = (b) => {
      calls++;
      return original(b);
    };
    adapters.mixer.setState('PRO');
    const pipeline = new PluginAudioPipeline(adapters, CANONICAL_PLUGIN_IDS);
    pipeline.process(BLOCK);
    pipeline.process(BLOCK);
    expect(calls).toBe(2);
  });

  it('transparenter Bypass lässt den AudioBlock unverändert', () => {
    const adapters = createPluginAdapters();
    const pipeline = new PluginAudioPipeline(adapters, CANONICAL_PLUGIN_IDS);
    const out = pipeline.process(BLOCK);
    expect(out).toBe(BLOCK);
  });

  it('erzeugt keine Duplikate in der Adapter-Menge', () => {
    const adapters = createPluginAdapters();
    expect(new Set(Object.values(adapters)).size).toBe(16);
  });

  it('dispose() ruft alle Adapter genau einmal auf', async () => {
    const adapters = createPluginAdapters();
    const disposed: string[] = [];
    for (const id of CANONICAL_PLUGIN_IDS) {
      const original = adapters[id].dispose.bind(adapters[id]);
      (adapters[id] as { dispose: () => Promise<void> }).dispose = async () => {
        disposed.push(id);
        return original();
      };
    }
    const pipeline = new PluginAudioPipeline(adapters, CANONICAL_PLUGIN_IDS);
    await pipeline.dispose();
    expect(disposed).toEqual([...CANONICAL_PLUGIN_IDS]);
  });

  it('Fehler eines Adapters werden kontrolliert behandelt (kein Pipeline-Abbruch)', () => {
    const adapters = createPluginAdapters();
    adapters.eq.setState('PRO');
    (adapters.eq as { process: (b: PluginAudioBlock) => PluginAudioBlock }).process = () => {
      throw new Error('eq boom');
    };
    const pipeline = new PluginAudioPipeline(adapters, CANONICAL_PLUGIN_IDS);
    const out = pipeline.process(BLOCK);
    expect(out).toBe(BLOCK);
  });

  it('process() liefert synchron zurück (kein Promise)', () => {
    const adapters = createPluginAdapters();
    const pipeline = new PluginAudioPipeline(adapters, CANONICAL_PLUGIN_IDS);
    const result = pipeline.process(BLOCK);
    expect(result).not.toBeInstanceOf(Promise);
  });
});
