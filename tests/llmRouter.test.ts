import { describe, it, expect } from 'vitest';
import { LlmRouter, type ILlmProvider, type LlmProviderId } from '../src/core/ai/LlmRouter';

const AI_ENV_KEYS = [
  'HF_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY',
  'OLLAMA_URL', 'OLLAMA_MODEL', 'GEMINI_API_KEY', 'OPENAI_API_KEY',
];

function stub(id: LlmProviderId, available: boolean): ILlmProvider {
  return {
    id,
    get available() { return available; },
    complete: async () => { throw new Error('stub'); },
  };
}

describe('LlmRouter: Provider-Reihenfolge', () => {
  it('simple: DeepSeek Flash → HF → Mistral → Ollama', () => {
    for (const k of AI_ENV_KEYS) delete process.env[k];
    const router = new LlmRouter();
    (['hf', 'mistral', 'ollama', 'deepseek-flash', 'deepseek-pro'] as LlmProviderId[])
      .forEach((id) => router.register(stub(id, true)));

    const order = router.rankProviders('simple').map((p) => p.id);
    expect(order).toEqual(['deepseek-flash', 'hf', 'mistral', 'ollama']);
  });

  it('moderate: DeepSeek Flash vorne, DeepSeek Pro vor Ollama', () => {
    for (const k of AI_ENV_KEYS) delete process.env[k];
    const router = new LlmRouter();
    (['hf', 'mistral', 'ollama', 'deepseek-flash', 'deepseek-pro'] as LlmProviderId[])
      .forEach((id) => router.register(stub(id, true)));

    const order = router.rankProviders('moderate').map((p) => p.id);
    expect(order).toEqual(['deepseek-flash', 'hf', 'mistral', 'deepseek-pro', 'ollama']);
  });

  it('complex: DeepSeek Pro zuerst, SambaNova existiert nicht mehr', () => {
    for (const k of AI_ENV_KEYS) delete process.env[k];
    const router = new LlmRouter();
    (['hf', 'mistral', 'ollama', 'deepseek-flash', 'deepseek-pro'] as LlmProviderId[])
      .forEach((id) => router.register(stub(id, true)));

    const order = router.rankProviders('complex').map((p) => p.id);
    expect(order[0]).toBe('deepseek-pro');
    expect(order).not.toContain('sambanova');
  });
});
