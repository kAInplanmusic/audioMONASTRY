import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelManager, type EndpointClient } from '../src/core/ai/orchestrator/modelManager';

// These eviction fixtures exercise the retained serverless model inventory.
const providerBefore = process.env.AI_GPU_PROVIDER;
beforeEach(() => { process.env.AI_GPU_PROVIDER = 'runpod'; });
afterEach(() => {
  if (providerBefore === undefined) delete process.env.AI_GPU_PROVIDER;
  else process.env.AI_GPU_PROVIDER = providerBefore;
});

function endpoint(log: string[]): EndpointClient {
  return {
    loadModel: async (id) => void log.push(`load:${id}`),
    unloadModel: async (id) => void log.push(`unload:${id}`),
    listModels: async () => [],
  };
}

describe('ModelManager residentOnly (alles resident, kein Tausch)', () => {
  it('lädt, solange es passt, und verdrängt danach nie – es wirft', async () => {
    const log: string[] = [];
    const mm = new ModelManager(endpoint(log), { vramBudgetGb: 12, vramSafetyMarginGb: 6, residentOnly: true });
    await mm.load('ast-audioset'); // 3 GB, frei 6 -> 3
    await expect(mm.load('whisper-large-v3')).rejects.toThrow(/resident-only.*nichts verdrängt/); // 5 GB > 3
    expect(log).toEqual(['load:ast-audioset']);
    expect(mm.isLoaded('ast-audioset')).toBe(true);
  });

  it('liest AI_RESIDENT_ONLY=1 aus der Umgebung', async () => {
    process.env.AI_RESIDENT_ONLY = '1';
    try {
      const mm = new ModelManager(endpoint([]), { vramBudgetGb: 12, vramSafetyMarginGb: 6 });
      await mm.load('ast-audioset');
      await expect(mm.load('whisper-large-v3')).rejects.toThrow(/resident-only/);
    } finally {
      delete process.env.AI_RESIDENT_ONLY;
    }
  });
});
