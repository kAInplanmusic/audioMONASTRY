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
import { beforeEach as beforeCompatibilityProvider, afterEach as afterCompatibilityProvider } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmRouter, readOpenAiSse, type ILlmProvider, type LlmCompletion, type LlmProviderId } from '../src/core/ai/LlmRouter';
import { splitSseEvents } from '../src/core/ai/clientLlm';
import { MoaAgent } from '../src/core/ai/MoaAgent';

// Explicit compatibility fixture: production now defaults to Vast.
beforeCompatibilityProvider(() => { process.env.AI_GPU_PROVIDER = 'vast'; });
afterCompatibilityProvider(() => { delete process.env.AI_GPU_PROVIDER; });

const ENV_KEYS = ['VAST_BRAIN_OPENAI_URL', 'VAST_BRAIN_MODEL', 'VAST_BRAIN_GUIDED_MODE', 'AI_ALLOW_EXTERNAL_LLM'];

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

describe('LlmRouter.completeStream', () => {
  beforeEach(() => {
    ENV_KEYS.forEach((k) => delete process.env[k]);
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => delete process.env[k]);
    vi.unstubAllGlobals();
  });

  // Entfallen mit der Vast-Migration: die beiden Tests des vLLM-SSE-Pfads
  // (Token-Strom über VAST_BRAIN_OPENAI_URL, guided_json/response_format).
  // `openAiUrl()` ist im Pod-Modus leer und die Vast-Flotte läuft immer im
  // Pod-Modus – der Pfad ist dort unerreichbar (Git-Historie bis 9394a65).

  it('nicht streamfähiger Provider: complete-Text kommt als EIN Chunk', async () => {
    const router = new LlmRouter();
    const fake: ILlmProvider = {
      id: 'vast-local' as LlmProviderId,
      available: true,
      complete: async (): Promise<LlmCompletion> => ({ provider: 'vast-local', text: 'ganz', latencyMs: 7 }),
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
      id: 'vast-local',
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

  it('readOpenAiSse puffert ein über Netz-Chunks zerteiltes Delta', async () => {
    const first = delta('{"comm');
    const tokens: string[] = [];
    for await (const token of readOpenAiSse(sseResponse([first.slice(0, 20), first.slice(20), delta('ands":[]}'), 'data: [DONE]\n\n']))) {
      tokens.push(token);
    }
    expect(tokens).toEqual(['{"comm', 'ands":[]}']);
  });

  it('readOpenAiSse meldet HTTP-Fehler mit Grund', async () => {
    const consume = async () => { for await (const _ of readOpenAiSse(new Response('model gone', { status: 404 }))) { /* leer */ } };
    await expect(consume()).rejects.toThrow('HTTP 404: model gone');
  });
});

describe('Client-SSE und MoaAgent', () => {
  it('splitSseEvents zerlegt Ereignisse und hält den unvollständigen Rest', () => {
    const { events, rest } = splitSseEvents('event: token\ndata: {"token":"a"}\n\nevent: done\ndata: {"provider":"vast-local"}\n\nevent: tok');
    expect(events).toEqual([
      { event: 'token', data: '{"token":"a"}' },
      { event: 'done', data: '{"provider":"vast-local"}' },
    ]);
    expect(rest).toBe('event: tok');
  });

  it('MoaAgent.plan reicht onToken als Strom-Anfrage durch und parst den Gesamttext', async () => {
    const complete = vi.fn(async (req: { stream?: boolean; onToken?: (t: string) => void }) => {
      req.onToken?.('[{"pluginId":"transport",');
      req.onToken?.('"command":"play","prompt":""}]');
      return { provider: 'vast-local' as const, text: '[{"pluginId":"transport","command":"play","prompt":""}]', latencyMs: 1 };
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
