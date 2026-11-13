import { afterEach, expect, it, vi } from 'vitest';
import manifest from '../services/audiomonastry-ai-runtime/model_manifest.json';
import { getModelDefinition, listModels, validateRegistry } from '../src/core/ai/orchestrator/modelRegistry';

afterEach(() => vi.unstubAllEnvs());
it('the Vast TS model catalog uses exactly the model identities/revisions and metadata loaded by the Python runtime', () => {
  vi.stubEnv('AI_GPU_PROVIDER', 'vast');
  expect(listModels().map((model) => model.id).sort()).toEqual(manifest.models.map((model) => model.id).sort());
  for (const model of manifest.models) {
    expect(getModelDefinition(model.id)).toMatchObject({
      repository: model.repository, revision: model.revision,
      estimatedVRAM: model.estimatedVRAM, estimatedRAM: model.estimatedRAM,
      framework: model.framework, concurrency: model.concurrency, timeout: model.timeout,
    });
  }
  expect(getModelDefinition('dsp-analysis')).toMatchObject({ task: 'audio.analyze', cpuOnly: true, estimatedVRAM: 0 });
  expect(getModelDefinition('basic-pitch')).toMatchObject({ task: 'audio.analyze', cpuOnly: true, estimatedVRAM: 0 });
  expect(validateRegistry()).toEqual([]);
  expect(getModelDefinition('flux-dev')).toBeUndefined();
});
