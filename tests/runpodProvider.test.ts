import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunPodProvider } from '../src/core/ai/orchestrator/runpodProvider';

const ENV_KEYS = [
  'RUNPOD_API_KEY',
  'RP_API_KEY',
  'RUNPOD_API_BASE',
  'RUNPOD_ENDPOINT_ID',
  'RUNPOD_ENDPOINT_ID_BRAIN',
  'RUNPOD_ENDPOINT_ID_EARS',
  'RUNPOD_ENDPOINT_ID_VOICE',
  'RUNPOD_BRAIN_MODEL',
  'AI_COST_RUNPOD_BRAIN_USD_PER_HOUR',
] as const;

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

let calls: RecordedCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url);
    }),
  );
}

describe('RunPodProvider (3-Rollen-Flotte)', () => {
  beforeEach(() => {
    calls = [];
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('vergibt je Rolle eine eigene Provider-ID', () => {
    expect(new RunPodProvider('brain').id).toBe('runpod-brain');
    expect(new RunPodProvider('ears').id).toBe('runpod-ears');
    expect(new RunPodProvider('voiceGen').id).toBe('runpod-voice');
  });

  it('bedient nur die Tasks der eigenen Rolle', () => {
    const brain = new RunPodProvider('brain');
    const ears = new RunPodProvider('ears');
    const voice = new RunPodProvider('voiceGen');

    expect(brain.canRun('llm')).toBe(true);
    expect(brain.canRun('nlu')).toBe(true);
    expect(brain.canRun('tts')).toBe(false);

    expect(ears.canRun('audio.transcribe')).toBe(true);
    expect(ears.canRun('audio.understand')).toBe(true);
    expect(ears.canRun('llm')).toBe(false);

    expect(voice.canRun('song')).toBe(true);
    expect(voice.canRun('stem.separate')).toBe(true);
    expect(voice.canRun('audio.embed')).toBe(false);
  });

  it('ist ohne Endpoint-ID und Key nicht verfügbar', async () => {
    const provider = new RunPodProvider('brain');
    expect(provider.available).toBe(false);
    await expect(provider.run('llm', 'qwen3-32b', {})).rejects.toMatchObject({
      code: 'ENDPOINT_NOT_CONFIGURED',
      retryable: false,
    });
  });

  it('nutzt runsync über api.runpod.ai/v2 für kurze Tasks', async () => {
    process.env.RUNPOD_API_KEY = 'rp_test';
    process.env.RUNPOD_ENDPOINT_ID_BRAIN = 'brain-ep';
    mockFetch(() => jsonResponse({ status: 'COMPLETED', output: { text: 'hallo' }, executionTime: 42 }));

    const provider = new RunPodProvider('brain');
    expect(provider.available).toBe(true);

    const output = await provider.run('llm', 'qwen3-32b', { prompt: 'hi' });
    expect(output).toEqual({ text: 'hallo' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.runpod.ai/v2/brain-ep/runsync');
  });

  it('nutzt run + Status-Polling für lange Tasks', async () => {
    process.env.RUNPOD_API_KEY = 'rp_test';
    process.env.RUNPOD_ENDPOINT_ID_VOICE = 'voice-ep';
    mockFetch((url) =>
      url.endsWith('/run')
        ? jsonResponse({ id: 'job-1', status: 'IN_QUEUE' })
        : jsonResponse({ id: 'job-1', status: 'COMPLETED', output: { audioUrl: 'r2://song.wav' } }),
    );

    const provider = new RunPodProvider('voiceGen');
    const output = await provider.run('song', 'acestep-v15-xl-turbo', { prompt: 'techno' });

    expect(output).toEqual({ audioUrl: 'r2://song.wav' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.runpod.ai/v2/voice-ep/run',
      'https://api.runpod.ai/v2/voice-ep/status/job-1',
    ]);
  });

  it('meldet Worker-Fehler aus dem Output als AiProviderError', async () => {
    process.env.RUNPOD_API_KEY = 'rp_test';
    process.env.RUNPOD_ENDPOINT_ID_BRAIN = 'brain-ep';
    mockFetch(() =>
      jsonResponse({ status: 'COMPLETED', output: { status: 'error', code: 'MODEL_UNAVAILABLE', message: 'nope' } }),
    );

    const provider = new RunPodProvider('brain');
    await expect(provider.run('llm', 'qwen3-32b', {})).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      retryable: false,
    });
  });

  it('meldet fehlendes Guthaben nicht als wiederholbar', async () => {
    process.env.RUNPOD_API_KEY = 'rp_test';
    process.env.RUNPOD_ENDPOINT_ID_EARS = 'ears-ep';
    mockFetch(() => new Response('no credit', { status: 402 }));

    const provider = new RunPodProvider('ears');
    await expect(provider.run('audio.transcribe', 'whisper-large-v3', {})).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDIT',
      retryable: false,
    });
    expect(calls).toHaveLength(1); // kein Retry bei 402
  });

  it('lädt beim Warmup die Preload-Modelle der Rolle', async () => {
    process.env.RUNPOD_API_KEY = 'rp_test';
    process.env.RUNPOD_ENDPOINT_ID_EARS = 'ears-ep';
    mockFetch((url) =>
      url.endsWith('/run') ? jsonResponse({ id: 'warm-1' }) : jsonResponse({ status: 'COMPLETED', output: { ready: true } }),
    );

    const provider = new RunPodProvider('ears');
    const result = await provider.warmup();

    expect(result.ok).toBe(true);
    expect(result.role).toBe('ears');
    expect(result.models).toContain('whisper-large-v3');
    expect(calls[0].url).toBe('https://api.runpod.ai/v2/ears-ep/run');
  });

  it('schätzt die Kosten aus dem Rollen-Stundensatz', () => {
    process.env.AI_COST_RUNPOD_BRAIN_USD_PER_HOUR = '1.20';
    const provider = new RunPodProvider('brain');
    // 10 s angenommene Jobdauer bei 1.20 USD/h = 0.00333…
    expect(provider.estimateCostUsd('llm', 'qwen3-32b')).toBeCloseTo((10 / 3600) * 1.2, 6);
  });
});
