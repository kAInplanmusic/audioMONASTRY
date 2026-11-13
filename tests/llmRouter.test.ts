import { beforeEach as beforeCompatibilityProvider, afterEach as afterCompatibilityProvider } from 'vitest';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { LlmRouter, extractWorkerText, type ILlmProvider, type LlmProviderId } from '../src/core/ai/LlmRouter';

// Explicit compatibility fixture: production now defaults to Vast.
beforeCompatibilityProvider(() => { process.env.AI_GPU_PROVIDER = 'vast'; });
afterCompatibilityProvider(() => { delete process.env.AI_GPU_PROVIDER; });

const ALL_IDS: LlmProviderId[] = ['vast-local', 'deepseek-flash', 'deepseek-pro'];

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
    expect(order).toEqual(['vast-local']);
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
    // RT-AUDIT-P1-014: außer DeepSeek V4 gibt es keine externen Provider mehr.
    expect(order).toEqual(['vast-local', 'deepseek-flash']);
  });

  it('moderate: lokales Brain vorne, Fallback-Kette bleibt erhalten', () => {
    process.env.AI_ALLOW_EXTERNAL_LLM = 'true';
    const router = new LlmRouter();
    ALL_IDS.forEach((id) => router.register(stub(id, true)));

    const order = router.rankProviders('moderate').map((p) => p.id);
    expect(order[0]).toBe('vast-local');
    expect(order).toContain('deepseek-flash');
    expect(order.indexOf('deepseek-flash')).toBeLessThan(order.indexOf('deepseek-pro'));
  });

  it('complex: DeepSeek Pro vor DeepSeek Flash, kein SambaNova', () => {
    process.env.AI_ALLOW_EXTERNAL_LLM = 'true';
    const router = new LlmRouter();
    ALL_IDS.forEach((id) => router.register(stub(id, true)));

    const order = router.rankProviders('complex').map((p) => p.id);
    expect(order[0]).toBe('vast-local');
    expect(order.indexOf('deepseek-pro')).toBeLessThan(order.indexOf('deepseek-flash'));
    expect(order as string[]).not.toContain('sambanova');
  });
});

/**
 * Das lokale Brain (Rolle `brain`) läuft auf dem Vast-Brain-Pod über den
 * nativen `task: "llm"`-Weg (/run + Status-Polling).
 */
describe('LlmRouter: lokales Brain (vast-local)', () => {
  const ENV_KEYS = [
    'AI_POD_TOKEN',
    'VAST_POD_URL_BRAIN',
    'VAST_POD_EUR_PER_HOUR_BRAIN',
    'VAST_BRAIN_MODEL',
    'VAST_BRAIN_OPENAI_URL',
  ] as const;

  function brainPodEnv(): void {
    process.env.AI_POD_TOKEN = 't'.repeat(32);
    process.env.VAST_POD_URL_BRAIN = 'https://brain.pods.example';
    process.env.VAST_POD_EUR_PER_HOUR_BRAIN = '0.4';
  }

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

  it('ruft den Brain-Pod nativ über /run + Status-Polling auf', async () => {
    brainPodEnv();
    mockFetch((url) =>
      url.endsWith('/ready')
        ? jsonResponse({ status: 'ready' })
        : url.endsWith('/run')
        ? jsonResponse({ id: 'job-1' })
        : jsonResponse({
            id: 'job-1',
            status: 'COMPLETED',
            output: { status: 'success', task: 'llm', model: 'qwen3-14b', result: { text: 'Hallo vom lokalen Brain' } },
          }),
    );

    const router = new LlmRouter();
    const completion = await router.complete({ prompt: 'Hi', complexity: 'simple' });

    expect(completion.provider).toBe('vast-local');
    expect(completion.text).toBe('Hallo vom lokalen Brain');
    const jobCalls = calls.filter((url) => !url.endsWith('/ready'));
    expect(jobCalls[0]).toBe('https://brain.pods.example/run');
    expect(jobCalls[1]).toBe('https://brain.pods.example/status/job-1');
  });

  it('zieht den Text auch aus einer verschachtelten Worker-Antwort', () => {
    expect(extractWorkerText({ result: { text: 'a' } })).toBe('a');
    expect(extractWorkerText({ text: 'b' })).toBe('b');
    expect(extractWorkerText('c')).toBe('c');
    expect(extractWorkerText({ result: {} })).toBe('');
    expect(extractWorkerText(null)).toBe('');
  });

  it('ist ohne Brain-Pod nicht verfügbar und fällt nicht stillschweigend durch', async () => {
    process.env.AI_POD_TOKEN = 't'.repeat(32);
    // keine Pod-Adresse gesetzt
    const router = new LlmRouter();
    expect(router.rankProviders('simple').map((p) => p.id)).toEqual([]);
    await expect(router.complete({ prompt: 'Hi', complexity: 'simple' })).rejects.toThrow(/Kein LLM-Provider/);
  });
});

/*
 * AI-P1-008 (OpenAI-kompatibler vLLM-Brain): die Tests dazu sind mit der
 * Vast-Migration entfallen. `LlmRouter.openAiUrl()` liefert im Pod-Modus
 * `undefined`, und die Vast-Flotte läuft immer im Pod-Modus – der Pfad ist
 * dort unerreichbar. Bis 9394a65 lagen die Tests hier (Git-Historie).
 */
