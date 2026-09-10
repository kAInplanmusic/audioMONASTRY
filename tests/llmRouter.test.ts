import { describe, it, expect, afterEach } from 'vitest';
import { LlmRouter, type ILlmProvider, type LlmProviderId } from '../src/core/ai/LlmRouter';

const ALL_IDS: LlmProviderId[] = [
  'runpod-local', 'hf', 'mistral', 'ollama', 'deepseek-flash', 'deepseek-pro',
  'cerebras', 'qwen3-coder', 'openrouter', 'publicai',
];

function stub(id: LlmProviderId, available: boolean): ILlmProvider {
  return {
    id,
    get available() { return available; },
    complete: async () => { throw new Error('stub'); },
  };
}

describe('LlmRouter: Provider-Reihenfolge (AI nur lokal)', () => {
  afterEach(() => {
    delete process.env.AI_ALLOW_EXTERNAL_LLM;
  });

  it('lässt per Default nur die lokalen Provider zu', () => {
    delete process.env.AI_ALLOW_EXTERNAL_LLM;
    const router = new LlmRouter();
    ALL_IDS.forEach((id) => router.register(stub(id, true)));

    const order = router.rankProviders('moderate').map((p) => p.id);
    expect(order).toEqual(['runpod-local', 'ollama']);
  });

  it('lässt unverfügbare Provider weg', () => {
    delete process.env.AI_ALLOW_EXTERNAL_LLM;
    const router = new LlmRouter();
    ALL_IDS.forEach((id) => router.register(stub(id, false)));

    expect(router.rankProviders('simple')).toEqual([]);
  });

  it('simple: lokales Brain vor allen externen Providern', () => {
    process.env.AI_ALLOW_EXTERNAL_LLM = 'true';
    const router = new LlmRouter();
    ALL_IDS.forEach((id) => router.register(stub(id, true)));

    const order = router.rankProviders('simple').map((p) => p.id);
    expect(order).toEqual([
      'runpod-local', 'ollama', 'cerebras', 'deepseek-flash', 'hf', 'mistral', 'openrouter', 'publicai',
    ]);
  });

  it('moderate: lokales Brain vorne, Fallback-Kette bleibt erhalten', () => {
    process.env.AI_ALLOW_EXTERNAL_LLM = 'true';
    const router = new LlmRouter();
    ALL_IDS.forEach((id) => router.register(stub(id, true)));

    const order = router.rankProviders('moderate').map((p) => p.id);
    expect(order[0]).toBe('runpod-local');
    expect(order).toContain('deepseek-flash');
    expect(order.indexOf('deepseek-flash')).toBeLessThan(order.indexOf('deepseek-pro'));
  });

  it('complex: DeepSeek Pro vor DeepSeek Flash, kein SambaNova', () => {
    process.env.AI_ALLOW_EXTERNAL_LLM = 'true';
    const router = new LlmRouter();
    ALL_IDS.forEach((id) => router.register(stub(id, true)));

    const order = router.rankProviders('complex').map((p) => p.id);
    expect(order[0]).toBe('runpod-local');
    expect(order.indexOf('deepseek-pro')).toBeLessThan(order.indexOf('deepseek-flash'));
    expect(order as string[]).not.toContain('sambanova');
  });
});
