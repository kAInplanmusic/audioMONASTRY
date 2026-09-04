import { describe, expect, it } from 'vitest';
import {
  getModelDefinition,
  listModels,
  validateRegistry,
} from '../src/core/ai/orchestrator/modelRegistry';

describe('FA-P2-2: Modelle nutzen repository + revision aus dem Manifest', () => {
  it('alle registrierten Modelle haben gepinnte Repositories/Revisions', () => {
    const errors = validateRegistry();
    expect(errors).toEqual([]);
  });

  it('getModelDefinition liefert repository + revision für bekannte Modelle', () => {
    for (const m of listModels()) {
      const def = getModelDefinition(m.id);
      expect(def?.repository).toBeTruthy();
      expect(def?.revision).toBeTruthy();
      expect(def?.revision.toLowerCase()).not.toBe('latest');
    }
  });

  it('validateRegistry erkennt latest-Revisionen und Duplikate', () => {
    const errors = validateRegistry([
      { id: 'a', repository: 'x/y', revision: 'latest', estimatedVRAM: 1, concurrency: 1 } as any,
      { id: 'a', repository: 'x/z', revision: 'abc', estimatedVRAM: 1, concurrency: 1 } as any,
    ]);
    expect(errors.some((e) => e.includes('revision pinning required'))).toBe(true);
    expect(errors.some((e) => e.includes('duplicate id'))).toBe(true);
  });
});
