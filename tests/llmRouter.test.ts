import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { LlmRouter, extractWorkerText, type ILlmProvider, type LlmProviderId } from '../src/core/ai/LlmRouter';

const ALL_IDS: LlmProviderId[] = [
  'runpod-local', 'mistral', 'ollama', 'deepseek-flash', 'deepseek-pro',
  'cerebras', 'openrouter', 'publicai',
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
      'runpod-local', 'ollama', 'cerebras', 'deepseek-flash', 'mistral', 'openrouter', 'publicai',
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

/**
 * Das lokale Brain (Rolle `brain`) wird über den Rollen-Endpoint angesprochen.
 * RunPod bietet `/openai/v1` NICHT für custom Serverless-Worker an – deshalb ist
 * der native `task: "llm"`-Weg der Default.
 */
describe('LlmRouter: lokales Brain (runpod-local)', () => {
  const ENV_KEYS = [
    'RUNPOD_API_KEY',
    'RP_API_KEY',
    'RUNPOD_API_BASE',
    'RUNPOD_ENDPOINT_ID',
    'RUNPOD_ENDPOINT_ID_BRAIN',
    'RUNPOD_BRAIN_MODEL',
    'RUNPOD_BRAIN_OPENAI_URL',
  ] as const;

  const calls: string[] = [];

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  function mockFetch(handler: (url: string) => Response): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        return handler(url);
      }),
    );
  }

  beforeEach(() => {
    calls.length = 0;
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('ruft den Brain-Endpoint nativ über /run + Status-Polling auf', async () => {
    process.env.RUNPOD_API_KEY = 'rp_test';
    process.env.RUNPOD_ENDPOINT_ID_BRAIN = 'brain-ep';
    mockFetch((url) =>
      url.endsWith('/run')
        ? jsonResponse({ id: 'job-1' })
        : jsonResponse({
            id: 'job-1',
            status: 'COMPLETED',
            output: { status: 'success', task: 'llm', model: 'qwen3-14b', result: { text: 'Hallo vom lokalen Brain' } },
          }),
    );

    const router = new LlmRouter();
    const completion = await router.complete({ prompt: 'Hi', complexity: 'simple' });

    expect(completion.provider).toBe('runpod-local');
    expect(completion.text).toBe('Hallo vom lokalen Brain');
    expect(calls[0]).toBe('https://api.runpod.ai/v2/brain-ep/run');
    expect(calls[1]).toBe('https://api.runpod.ai/v2/brain-ep/status/job-1');
  });

  it('nutzt den OpenAI-Pfad nur, wenn RUNPOD_BRAIN_OPENAI_URL gesetzt ist', async () => {
    process.env.RUNPOD_API_KEY = 'rp_test';
    process.env.RUNPOD_ENDPOINT_ID_BRAIN = 'brain-ep';
    process.env.RUNPOD_BRAIN_OPENAI_URL = 'https://brain.example/v1';
    mockFetch(() => jsonResponse({ choices: [{ message: { content: 'vLLM-Antwort' } }] }));

    const router = new LlmRouter();
    const completion = await router.complete({ prompt: 'Hi', complexity: 'simple' });

    expect(completion.provider).toBe('runpod-local');
    expect(completion.text).toBe('vLLM-Antwort');
    expect(calls[0]).toBe('https://brain.example/v1/chat/completions');
  });

  it('zieht den Text auch aus einer verschachtelten Worker-Antwort', () => {
    expect(extractWorkerText({ result: { text: 'a' } })).toBe('a');
    expect(extractWorkerText({ text: 'b' })).toBe('b');
    expect(extractWorkerText('c')).toBe('c');
    expect(extractWorkerText({ result: {} })).toBe('');
    expect(extractWorkerText(null)).toBe('');
  });

  it('ist ohne Brain-Endpoint nicht verfügbar und fällt nicht stillschweigend durch', async () => {
    process.env.RUNPOD_API_KEY = 'rp_test';
    // keine Endpoint-ID gesetzt
    const router = new LlmRouter();
    expect(router.rankProviders('simple').map((p) => p.id)).toEqual([]);
    await expect(router.complete({ prompt: 'Hi', complexity: 'simple' })).rejects.toThrow(/Kein LLM-Provider/);
  });
});
