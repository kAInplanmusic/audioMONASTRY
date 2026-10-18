/**
 * DA-2026-10-17-016 · Begrenztes RunPod-Polling
 * =============================================
 * Der Befund: die Status-Schleife lief bis zur globalen Deadline (Default
 * 600 s), ohne Versuchsdeckel, ohne Jitter und - sobald ein Aufrufer-Signal
 * gesetzt war - ohne eigenen Request-Timeout. Ein haengender Status-Endpunkt
 * belegte den Aufrufer damit bis zum Ende.
 *
 * Geprueft wird das echte `RunPodProvider.pollLoop` (ueber `run`), nicht ein
 * Nachbau: Deadline, Versuchsdeckel, Toleranz fuer transiente Fehler und das
 * Abbruchsignal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunPodProvider } from '../src/core/ai/orchestrator/runpodProvider';
import { __resetAiGate } from '../src/core/ai/aiGate';

const ENV_KEYS = [
  'RP_AGENT_KEY', 'RUNPOD_API_BASE', 'RUNPOD_ENDPOINT_ID_MUSIC',
  'RUNPOD_AI_TASK_TIMEOUT_MS', 'RUNPOD_POLL_INITIAL_MS', 'RUNPOD_POLL_MAX_DELAY_MS',
  'RUNPOD_POLL_MAX_ATTEMPTS', 'RUNPOD_POLL_MAX_ERRORS', 'AI_MODE', 'AI_OPERATING_MODE',
] as const;

interface Call { url: string }

let calls: Call[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    return handler(url);
  }));
}

function setup(): void {
  process.env.RP_AGENT_KEY = 'rp_test';
  process.env.RUNPOD_ENDPOINT_ID_MUSIC = 'music-ep';
  process.env.RUNPOD_POLL_INITIAL_MS = '10';
  process.env.RUNPOD_POLL_MAX_DELAY_MS = '40';
  process.env.RUNPOD_POLL_MAX_ERRORS = '3';
}

const statusCalls = (): number => calls.filter((c) => c.url.includes('/status/')).length;

beforeEach(() => {
  calls = [];
  __resetAiGate();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAiGate();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('DA-2026-10-17-016 · RunPod-Polling ist begrenzt', () => {
  it('endet an der Deadline mit TIMEOUT statt bis 600 s zu laufen', async () => {
    setup();
    process.env.RUNPOD_AI_TASK_TIMEOUT_MS = '700';
    stubFetch((url) => (url.endsWith('/run')
      ? jsonResponse({ id: 'job-1', status: 'IN_QUEUE' })
      : jsonResponse({ id: 'job-1', status: 'IN_PROGRESS' })));

    const provider = new RunPodProvider('music');
    const started = Date.now();
    await expect(provider.run('song', 'acestep-v15-xl-sft', { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    // Der Versuchsdeckel greift, es wird nicht in einer heissen Schleife gepollt.
    expect(statusCalls()).toBeGreaterThan(0);
    expect(statusCalls()).toBeLessThan(40);
  }, 20_000);

  it('respektiert RUNPOD_POLL_MAX_ATTEMPTS auch bei langer Deadline', async () => {
    setup();
    process.env.RUNPOD_AI_TASK_TIMEOUT_MS = '60000';
    process.env.RUNPOD_POLL_MAX_ATTEMPTS = '2';
    stubFetch((url) => (url.endsWith('/run')
      ? jsonResponse({ id: 'job-2', status: 'IN_QUEUE' })
      : jsonResponse({ id: 'job-2', status: 'IN_QUEUE' })));

    const provider = new RunPodProvider('music');
    await expect(provider.run('song', 'acestep-v15-xl-sft', { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(statusCalls()).toBe(2);
  }, 20_000);

  it('bricht beim Abbruchsignal sofort ab (CANCELLED)', async () => {
    setup();
    process.env.RUNPOD_AI_TASK_TIMEOUT_MS = '60000';
    const controller = new AbortController();
    stubFetch((url) => {
      if (url.endsWith('/run')) return jsonResponse({ id: 'job-3', status: 'IN_QUEUE' });
      controller.abort();
      return jsonResponse({ id: 'job-3', status: 'IN_PROGRESS' });
    });

    const provider = new RunPodProvider('music');
    await expect(provider.run('song', 'acestep-v15-xl-sft', { prompt: 'x' }, controller.signal))
      .rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    // Nach dem Abbruch kein weiterer Status-GET.
    expect(statusCalls()).toBe(1);
  }, 20_000);

  it('toleriert einen transienten 500er und liefert danach das Ergebnis', async () => {
    setup();
    process.env.RUNPOD_AI_TASK_TIMEOUT_MS = '10000';
    let statusSeen = 0;
    stubFetch((url) => {
      if (url.endsWith('/run')) return jsonResponse({ id: 'job-4', status: 'IN_QUEUE' });
      statusSeen += 1;
      if (statusSeen === 1) return jsonResponse({ error: 'boom' }, 500);
      return jsonResponse({ id: 'job-4', status: 'COMPLETED', output: { audioUrl: 'r2://x.wav' } });
    });

    const provider = new RunPodProvider('music');
    const output = await provider.run('song', 'acestep-v15-xl-sft', { prompt: 'x' });
    // Antwortformat unveraendert: der Output des Jobs, nicht ein Wrapper.
    expect(output).toEqual({ audioUrl: 'r2://x.wav' });
    expect(statusSeen).toBe(2);
  }, 20_000);

  it('gibt nach zu vielen aufeinanderfolgenden 5xx auf (kein Endlos-Poll)', async () => {
    setup();
    process.env.RUNPOD_AI_TASK_TIMEOUT_MS = '60000';
    stubFetch((url) => (url.endsWith('/run')
      ? jsonResponse({ id: 'job-5', status: 'IN_QUEUE' })
      : jsonResponse({ error: 'kaputt' }, 500)));

    const provider = new RunPodProvider('music');
    await expect(provider.run('song', 'acestep-v15-xl-sft', { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'HTTP_500', retryable: true });
    // maxErrors=3 -> beim vierten Fehler Schluss.
    expect(statusCalls()).toBe(4);
  }, 20_000);

  it('meldet 404 sofort als JOB_NOT_FOUND (kein Retry)', async () => {
    setup();
    process.env.RUNPOD_AI_TASK_TIMEOUT_MS = '60000';
    stubFetch((url) => (url.endsWith('/run')
      ? jsonResponse({ id: 'job-6', status: 'IN_QUEUE' })
      : jsonResponse({ error: 'unbekannt' }, 404)));

    const provider = new RunPodProvider('music');
    await expect(provider.run('song', 'acestep-v15-xl-sft', { prompt: 'x' }))
      .rejects.toMatchObject({ code: 'JOB_NOT_FOUND', retryable: false });
    expect(statusCalls()).toBe(1);
  }, 20_000);
});
