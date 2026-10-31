import { describe, expect, it } from 'vitest';
import { attachServerMetadata, parseLlmJsonObject } from '../src/core/ai/llmJson';

describe('DB-010: never trust LLM-provided server metadata', () => {
  it('preserves server task_id and provider after malicious model response', () => {
    const model = parseLlmJsonObject(JSON.stringify({
      task_id: 'forged-task',
      source: 'forged-origin',
      provider: 'fake-processor',
      bpm: 130,
      patterns: { kick: Array(16).fill(true) },
    }));
    expect(model).not.toBeNull();
    const actual = attachServerMetadata(model!, {
      task_id: 'server-123', source: 'runpod-local', provider: 'runpod-local',
    });
    expect(actual).toMatchObject({
      task_id: 'server-123',
      source: 'runpod-local',
      provider: 'runpod-local',
      bpm: 130,
    });
  });
  it('does not mutate LLM output object or permit metadata downgrade', () => {
    const model = Object.freeze({ genre: 'Techno', task_id: null, provider: 0, source: '' });
    const actual = attachServerMetadata(model, {
      task_id: 'server-456', source: 'local', provider: 'local',
    });
    expect(actual).toEqual({ genre: 'Techno', task_id: 'server-456', source: 'local', provider: 'local' });
    expect(model.task_id).toBeNull();
  });
});
