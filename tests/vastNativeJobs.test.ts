// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VastProvider } from '../src/core/ai/orchestrator/vastProvider';

vi.mock('../src/core/ai/orchestrator/podStartTriggers', () => ({
  ensurePodForJob: vi.fn(), markPodStale: vi.fn(), notePodActivity: vi.fn(),
  PodWakeBlockedError: class extends Error {},
}));

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const output = { status: 'success', result: { embedding: [1, 2, 3] } };

beforeEach(() => {
  vi.stubEnv('AI_GPU_PROVIDER', 'vast');
  vi.stubEnv('AI_POD_TOKEN', 'fixture-token-longer-than-thirty-two-characters');
  vi.stubEnv('VAST_POD_URL_EARS', 'https://ears.example');
  vi.stubEnv('VAST_POLL_INITIAL_MS', '0');
  vi.stubEnv('VAST_AI_TASK_TIMEOUT_MS', '2000');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('native Vast jobs preserve worker completion contracts', () => {
  it('runLong polls the same queued job and returns its worker envelope', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: 'job/1', status: 'IN_QUEUE' }))
      .mockResolvedValueOnce(response({ id: 'job/1', status: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(response({ id: 'job/1', status: 'COMPLETED', output }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new VastProvider('ears').runLong('audio.embed', 'clap-music', {})).resolves.toEqual(output);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://ears.example/run', 'https://ears.example/status/job%2F1', 'https://ears.example/status/job%2F1',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ input: { task: 'audio.embed', model: 'clap-music', input: {} } });
  });

  it('short tasks retain runsync and follow a cold-start receipt without resubmitting', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: 'cold', status: 'IN_QUEUE' }))
      .mockResolvedValueOnce(response({ id: 'cold', status: 'COMPLETED', output }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new VastProvider('ears').run('audio.embed', 'clap-music', {})).resolves.toEqual(output);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://ears.example/runsync', 'https://ears.example/status/cold']);
  });

  it('does not treat missing job identity or missing completed output as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 'IN_QUEUE' })));
    await expect(new VastProvider('ears').runLong('audio.embed', 'clap-music', {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 'COMPLETED' })));
    await expect(new VastProvider('ears').runLong('audio.embed', 'clap-music', {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('propagates worker failures inside a COMPLETED job and preserves nonretryable model failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ status: 'COMPLETED', output: { status: 'error', code: 'MODEL_UNAVAILABLE', message: 'not resident' } })));
    await expect(new VastProvider('ears').runLong('audio.embed', 'clap-music', {})).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: false });
  });

  it('retries a transient status failure without creating another paid job', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: 'retry', status: 'IN_QUEUE' }))
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response({ status: 'COMPLETED', output }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new VastProvider('ears').runLong('audio.embed', 'clap-music', {})).resolves.toEqual(output);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/run'))).toHaveLength(1);
  });

  it.each(['cancel', 'timeout'] as const)('bounds an in-flight status fetch on %s and requests remote cancellation', async (kind) => {
    const caller = new AbortController();
    if (kind === 'timeout') vi.stubEnv('VAST_AI_TASK_TIMEOUT_MS', '40');
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/run')) return response({ id: 'pending', status: 'IN_QUEUE' });
      if (url.includes('/cancel/')) return response({ cancelled: true });
      return new Promise<Response>((_resolve, reject) => {
        const aborted = () => reject(init.signal?.reason);
        init.signal?.addEventListener('abort', aborted, { once: true });
        if (init.signal?.aborted) aborted();
        if (kind === 'cancel') caller.abort();
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new VastProvider('ears').runLong('audio.embed', 'clap-music', {}, caller.signal))
      .rejects.toMatchObject({ code: kind === 'cancel' ? 'CANCELLED' : 'TIMEOUT' });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === 'https://ears.example/cancel/pending')).toBe(true));
  });
});
