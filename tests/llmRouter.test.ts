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
    'RP_AGENT_KEY',
    'RUNPOD_API_BASE',
    'RUNPOD_ENDPOINT_ID',
    'RUNPOD_ENDPOINT_ID_BRAIN',
    'RP_ENDPOINT_ID',
    'RP_ENDPOINT_ID_BRAIN',
    'RUNPOD_BRAIN_MODEL',
    'RUNPOD_BRAIN_OPENAI_URL',
    'RP_BRAIN_OPENAI_URL',
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

/**
 * AI-P1-008 (live gefunden 2026-09-18): Der OpenAI-kompatible Brain-Endpoint wurde
 * NUR unter `RUNPOD_BRAIN_OPENAI_URL` erkannt, waehrend `available` auch
 * `RP_BRAIN_OPENAI_URL` akzeptierte. Mit dem in `.env` gesetzten `RP_`-Namen galt
 * der Provider damit als verfuegbar, der Aufruf lief aber in den NATIVEN
 * Worker-Pfad - und der lehnt das Payload ab
 * ("Job input must contain one of: openai_input ...").
 * Zweiter Fehler: der vLLM-Endpoint adressiert sein Modell ueber den
 * HuggingFace-Namen (`Qwen/Qwen3-14B-AWQ`), nicht ueber den internen Kurznamen
 * (`qwen3-14b`) - dieser 404 wurde als stiller Fallback auf lokale Ersatzpfade
 * sichtbar. Beide Fehler sind hier festgehalten.
 */
describe('LlmRouter: OpenAI-kompatibler Brain-Endpoint (AI-P1-008)', () => {
  const ENV_KEYS = ['RP_BRAIN_OPENAI_URL', 'RUNPOD_BRAIN_OPENAI_URL', 'RP_API_KEY', 'RUNPOD_BRAIN_OPENAI_MODEL', 'RP_BRAIN_OPENAI_MODEL', 'RUNPOD_BRAIN_MODEL'];

  beforeEach(() => {
    ENV_KEYS.forEach((k) => delete process.env[k]);
    delete process.env.AI_ALLOW_EXTERNAL_LLM;
    // NUR die RP_-Schreibweise setzen: genau die Konstellation aus .env.
    process.env.RP_BRAIN_OPENAI_URL = 'https://api.runpod.ai/v2/ppxo7wrn599p0q/openai/v1';
    process.env.RP_API_KEY = 'rpa_test';
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => delete process.env[k]);
    vi.unstubAllGlobals();
  });

  const okResponse = { choices: [{ message: { content: 'OK' } }] };

  it('nutzt den OpenAI-Pfad auch bei RP_BRAIN_OPENAI_URL (nicht den nativen Worker-Pfad)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okResponse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const router = new LlmRouter();
    const provider = router.rankProviders('moderate')[0];
    expect(provider?.id).toBe('runpod-local');
    const completion = await provider!.complete({ prompt: 'Test', complexity: 'moderate' });

    expect(completion.text).toBe('OK');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.runpod.ai/v2/ppxo7wrn599p0q/openai/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as { model: string; messages: unknown[] };
    // HuggingFace-Name des Endpoint-Modells - nicht 'qwen3-14b'.
    expect(body.model).toBe('Qwen/Qwen3-14B-AWQ');
    expect(body.messages).toHaveLength(1);
  });

  it('erlaubt das Modell per Env zu ueberschreiben', async () => {
    process.env.RUNPOD_BRAIN_OPENAI_MODEL = 'Qwen/Qwen3-32B-AWQ';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okResponse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new LlmRouter().rankProviders('moderate')[0];
    await provider!.complete({ prompt: 'Test', complexity: 'moderate' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { model: string }).model).toBe('Qwen/Qwen3-32B-AWQ');
  });

  it('meldet einen abgelehnten Modellnamen mit Modell und Stellschraube', async () => {
    const workerError = { message: 'The model `qwen3-14b` does not exist.', type: 'worker_error', code: null };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(workerError), { status: 500 })));

    const provider = new LlmRouter().rankProviders('moderate')[0];
    await expect(provider!.complete({ prompt: 'Test', complexity: 'moderate' }))
      .rejects.toThrowError(/lehnt Modell.*RUNPOD_BRAIN_OPENAI_MODEL/s);
  });
});
