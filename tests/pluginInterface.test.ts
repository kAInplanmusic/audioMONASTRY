import { describe, expect, it } from 'vitest';
import { createPluginAdapters, CANONICAL_PLUGIN_IDS } from '../src/plugins/adapters';
import type { PluginInterface, PluginRuntimeContext } from '../src/plugins/plugin_interface';

function makeContext(overrides: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  return {
    audio: {
      id: 'test-audio',
      init: async () => undefined,
      play: async () => undefined,
      stop: () => undefined,
      setTempo: () => undefined,
      getTempo: () => 120,
      loadTrackSample: async () => undefined,
      triggerEvent: () => undefined,
      setChannelGain: () => undefined,
      setChannelPan: () => undefined,
      setChannelEQ: () => undefined,
      setMasterVolume: () => undefined,
      onStepUpdate: () => () => undefined,
    },
    userId: 'User1',
    requestLock: () => true,
    releaseLock: () => undefined,
    isLockedByOther: () => false,
    log: () => undefined,
    ...overrides,
  };
}

const BLOCK = {
  channels: [new Float32Array([0.1, 0.2])],
  sampleRate: 48000,
  timestamp: 0,
  frameCount: 2,
};

describe('Plugin-Interface-Konformität (16 kanonische Adapter)', () => {
  it('erzeugt exakt 16 Adapter', () => {
    const adapters = createPluginAdapters();
    expect(Object.keys(adapters)).toHaveLength(16);
    expect(Object.keys(adapters).sort()).toEqual([...CANONICAL_PLUGIN_IDS].sort());
  });

  it('jeder Adapter implementiert das PluginInterface', () => {
    const adapters = createPluginAdapters();
    for (const adapter of Object.values(adapters)) {
      const p = adapter as PluginInterface;
      expect(typeof p.initialize).toBe('function');
      expect(typeof p.setState).toBe('function');
      expect(typeof p.setParameter).toBe('function');
      expect(typeof p.process).toBe('function');
      expect(typeof p.handleCommand).toBe('function');
      expect(typeof p.snapshot).toBe('function');
      expect(typeof p.restore).toBe('function');
      expect(typeof p.dispose).toBe('function');
    }
  });

  it('jeder Adapter besitzt eine eindeutige kanonische ID', () => {
    const adapters = createPluginAdapters();
    const ids = Object.values(adapters).map((a) => a.manifest.id);
    expect(new Set(ids).size).toBe(16);
    for (const id of CANONICAL_PLUGIN_IDS) expect(ids).toContain(id);
  });

  it('jeder Adapter besitzt ein gültiges Manifest', () => {
    const adapters = createPluginAdapters();
    for (const adapter of Object.values(adapters)) {
      expect(adapter.manifest.id.length).toBeGreaterThan(0);
      expect(adapter.manifest.name.length).toBeGreaterThan(0);
      expect(adapter.manifest.capabilities.length).toBeGreaterThan(0);
      expect(adapter.manifest.latencySamples).toBeGreaterThanOrEqual(0);
      expect(adapter.manifest.tailSamples).toBeGreaterThanOrEqual(0);
    }
  });

  it('OFF ist ein transparenter Bypass', async () => {
    const adapters = createPluginAdapters();
    for (const adapter of Object.values(adapters)) {
      await adapter.initialize(makeContext());
      expect(adapter.state).toBe('OFF');
      expect(adapter.process(BLOCK)).toBe(BLOCK);
    }
  });

  it('State-Wechsel OFF → AUTO_AI → PRO funktioniert', async () => {
    const adapters = createPluginAdapters();
    const adapter = adapters.mixer;
    await adapter.initialize(makeContext());
    adapter.setState('AUTO_AI');
    expect(adapter.state).toBe('AUTO_AI');
    adapter.setState('PRO');
    expect(adapter.state).toBe('PRO');
    adapter.setState('OFF');
    expect(adapter.state).toBe('OFF');
  });

  it('Snapshot und Restore sind deterministisch', async () => {
    const adapters = createPluginAdapters();
    const adapter = adapters.eq;
    await adapter.initialize(makeContext());
    adapter.setState('PRO');
    adapter.setParameter({ name: 'band1', value: 3 });
    const snapshot = adapter.snapshot();
    expect(snapshot.pluginId).toBe('eq');
    expect(snapshot.state).toBe('PRO');

    adapter.setState('OFF');
    adapter.restore(snapshot);
    expect(adapter.state).toBe('PRO');
    expect(adapter.snapshot().parameters).toEqual(snapshot.parameters);
  });

  it('dispose() ist idempotent', async () => {
    const adapters = createPluginAdapters();
    const adapter = adapters.master;
    await adapter.initialize(makeContext());
    await adapter.dispose();
    await adapter.dispose(); // darf nicht werfen
    expect(() => adapter.process(BLOCK)).toThrow(/disposed/);
  });

  it('fremder Lock verhindert Parameteränderungen und Commands', async () => {
    const adapters = createPluginAdapters();
    const adapter = adapters.dsp;
    await adapter.initialize(makeContext({ isLockedByOther: () => true }));
    adapter.setParameter({ name: 'drive', value: 0.9 });
    expect(adapter.snapshot().parameters.drive).toBeUndefined();
    await expect(adapter.handleCommand({ name: 'automate' })).rejects.toThrow(/locked/);
  });
});
