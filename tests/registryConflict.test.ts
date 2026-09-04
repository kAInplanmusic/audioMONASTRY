import { describe, expect, it } from 'vitest';
import { getPluginRegistry, METAMODULE_GROUPS, resolvePrimaryModule } from '../src/plugins/registry';

describe('Plugin-Registry (Konflikt-/Versionierungs-Check, AM-E2-5)', () => {
  it('hat 21 eindeutige Plugin-IDs', () => {
    const registry = getPluginRegistry();
    expect(registry.length).toBe(21);
    const ids = registry.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Metamodul-Gruppen lösen deterministisch auf und haben keine Doppelmitgliedschaft', () => {
    const members = METAMODULE_GROUPS.flatMap((g) => g.members);
    expect(new Set(members).size).toBe(members.length);
    for (const g of METAMODULE_GROUPS) {
      expect(g.members).toContain(g.primary);
      expect(resolvePrimaryModule(g.primary)).toBe(g.primary);
      for (const m of g.members) expect(resolvePrimaryModule(m)).toBe(g.primary);
    }
  });
});
