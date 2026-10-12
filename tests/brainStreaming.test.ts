/**
 * RT-AUDIT-P1-015 · Streaming bis in die UI.
 *
 *   vLLM-Brain (SSE) → LlmRouter.completeStream (onToken + ttftMs)
 *   → /api/ai/complete/stream (SSE an den Browser) → clientLlm.streamLlm
 *   → MoaAgent.plan(onToken) → useMoaRun.live → aiMONK-Terminal/Dock.
 *
 * Hier ohne Netz geprüft: Router-Strom inkl. guided_json, Fallback-Regeln,
 * SSE-Zerlegung im Client und dass MoaAgent die Tokens durchreicht.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmRouter, readOpenAiSse, type ILlmProvider, type LlmCompletion, type LlmProviderId } from '../src/core/ai/LlmRouter';
import { splitSseEvents } from '../src/core/ai/clientLlm';
import { MoaAgent } from '../src/core/ai/MoaAgent';

const ENV_KEYS = ['RP_BRAIN_OPENAI_URL', 'RUNPOD_BRAIN_OPENAI_URL', 'RP_API_KEY', 'RUNPOD_BRAIN_OPENAI_MODEL', 'RP_BRAIN_OPENAI_MODEL', 'RUNPOD_BRAIN_MODEL', 'RUNPOD_BRAIN_GUIDED_MODE', 'AI_ALLOW_EXTERNAL_LLM'];

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe('LlmRouter.completeStream (vLLM-Brain)', () => {
  beforeEach(() => {
    ENV_KEYS.forEach((k) => delete process.env[k]);
    process.env.RP_BRAIN_OPENAI_URL = 'https://brain.example/openai/v1';
    process.env.RP_API_KEY = 'rpa_test';
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => delete process.env[k]);
    vi.unstubAllGlobals();
  });

  it('streamt Tokens einzeln, liefert Gesamttext + TTFT und fordert stream:true an', async () => {
    // Ein Delta über zwei Netz-Chunks zerteilt: der Parser muss puffern.
    const first = delta('{"comm');
    const fetchMock = vi.fn(async () => sseResponse([first.slice(0, 20), first.slice(20), delta('ands":[]}'), 'data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const tokens: string[] = [];
    const completion = await new LlmRouter().completeStream({ prompt: 'x', complexity: 'moderate' }, (t) => tokens.push(t));

    expect(tokens).toEqual(['{"comm', 'ands":[]}']);
    expect(completion.text).toBe('{"commands":[]}');
    expect(completion.provider).toBe('runpod-local');
    expect(typeof completion.ttftMs).toBe('number');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://brain.example/openai/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('reicht das Executor-Schema als guided_json durch (oder response_format, nie beides)', async () => {
    const schema = { type: 'object' };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new LlmRouter().rankProviders('simple')[0]!;

    await provider.complete({ prompt: 'x', complexity: 'simple', jsonSchema: schema });
    let body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.guided_json).toEqual(schema);
    expect(body.response_format).toBeUndefined();

    process.env.RUNPOD_BRAIN_GUIDED_MODE = 'response_format';
    await provider.complete({ prompt: 'x', complexity: 'simple', jsonSchema: schema });
    body = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.guided_json).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'daw_commands', schema } });
  });

  it('nicht streamfähiger Provider: complete-Text kommt als EIN Chunk', async () => {
    const router = new LlmRouter();
    const fake: ILlmProvider = {
      id: 'runpod-local' as LlmProviderId,
      available: true,
      complete: async (): Promise<LlmCompletion> => ({ provider: 'runpod-local', text: 'ganz', latencyMs: 7 }),
    };
    router.register(fake);
    const tokens: string[] = [];
    const completion = await router.completeStream({ prompt: 'x', complexity: 'simple' }, (t) => tokens.push(t));
    expect(tokens).toEqual(['ganz']);
    expect(completion.ttftMs).toBe(7);
  });

  it('Fehler vor dem ersten Token → nächster Provider; mitten im Strom → Abbruch', async () => {
    process.env.AI_ALLOW_EXTERNAL_LLM = 'true';
    const router = new LlmRouter();
    const failing: ILlmProvider = {
      id: 'runpod-local',
      available: true,
      complete: async () => { throw new Error('nope'); },
      completeStream: async function* () { throw new Error('kalt'); },
    };
    const backup: ILlmProvider = {
      id: 'deepseek-flash',
      available: true,
      complete: async () => ({ provider: 'deepseek-flash', text: '', latencyMs: 1 }),
      completeStream: async function* () { yield 'ok'; },
    };
    router.register(failing);
    router.register(backup);
    const tokens: string[] = [];
    const completion = await router.completeStream({ prompt: 'x', complexity: 'simple' }, (t) => tokens.push(t));
    expect(completion.provider).toBe('deepseek-flash');
    expect(tokens).toEqual(['ok']);

    const midStream: ILlmProvider = {
      ...failing,
      completeStream: async function* () { yield 'halb'; throw new Error('abgerissen'); },
    };
    router.register(midStream);
    const seen: string[] = [];
    await expect(router.completeStream({ prompt: 'x', complexity: 'simple' }, (t) => seen.push(t))).rejects.toThrow('abgerissen');
    expect(seen).toEqual(['halb']); // kein zusammengestückelter Text vom Backup
  });

  it('readOpenAiSse meldet HTTP-Fehler mit Grund', async () => {
    const consume = async () => { for await (const _ of readOpenAiSse(new Response('model gone', { status: 404 }))) { /* leer */ } };
    await expect(consume()).rejects.toThrow('HTTP 404: model gone');
  });
});

describe('Client-SSE und MoaAgent', () => {
  it('splitSseEvents zerlegt Ereignisse und hält den unvollständigen Rest', () => {
    const { events, rest } = splitSseEvents('event: token\ndata: {"token":"a"}\n\nevent: done\ndata: {"provider":"runpod-local"}\n\nevent: tok');
    expect(events).toEqual([
      { event: 'token', data: '{"token":"a"}' },
      { event: 'done', data: '{"provider":"runpod-local"}' },
    ]);
    expect(rest).toBe('event: tok');
  });

  it('MoaAgent.plan reicht onToken als Strom-Anfrage durch und parst den Gesamttext', async () => {
    const complete = vi.fn(async (req: { stream?: boolean; onToken?: (t: string) => void }) => {
      req.onToken?.('[{"pluginId":"transport",');
      req.onToken?.('"command":"play","prompt":""}]');
      return { provider: 'runpod-local' as const, text: '[{"pluginId":"transport","command":"play","prompt":""}]', latencyMs: 1 };
    });
    const agent = new MoaAgent(complete as never, { execute: async () => ({ handled: true, pluginId: '' }) });
    const tokens: string[] = [];
    const plan = await agent.plan('abspielen', '', '', undefined, (t) => tokens.push(t));
    expect(tokens.join('')).toContain('"command":"play"');
    expect(complete.mock.calls[0][0].stream).toBe(true);
    expect(plan.steps).toEqual([{ pluginId: 'transport', command: 'play', prompt: '' }]);

    // Ohne onToken bleibt der Nicht-Stream-Weg unverändert.
    await agent.plan('abspielen');
    expect(complete.mock.calls[1][0].stream).toBeUndefined();
  });
});
