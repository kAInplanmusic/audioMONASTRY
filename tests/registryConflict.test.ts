import { describe, expect, it } from 'vitest';
import { getPluginRegistry } from '../src/plugins/registry';

describe('Plugin-Registry (ARCH-PLUGIN-001: exakt 16 echte MONKs)', () => {
  it('hat exakt 16 eindeutige Plugin-IDs in Ziel-Reihenfolge', () => {
    const registry = getPluginRegistry();
    expect(registry.length).toBe(16);
    const ids = registry.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'mixer', 'drop', 'song', 'effect',
      'syntisampler', 'drumsampler', 'instru', 'biblio',
      'voice', 'sound', 'stem', 'spatial',
      'eq', 'dsp', 'master', 'record',
    ]);
  });

  it('jedes Plugin hat Name, Short und Komponente', () => {
    for (const p of getPluginRegistry()) {
      expect(typeof p.name).toBe('string');
      expect(p.name.endsWith('MONK')).toBe(true);
      expect(typeof p.short).toBe('string');
      expect(p.component).toBeTruthy();
    }
  });
});
