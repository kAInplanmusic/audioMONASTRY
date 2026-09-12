import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFleetWakeState,
  fleetStatus,
  sleepFleet,
  wakeFleet,
} from '../src/core/ai/orchestrator/fleetWake';

const ENV_KEYS = [
  'RUNPOD_API_KEY',
  'RP_API_KEY',
  'RUNPOD_REST_BASE',
  'RUNPOD_API_BASE',
  'RUNPOD_ENDPOINT_ID',
  'RUNPOD_ENDPOINT_ID_BRAIN',
  'RUNPOD_ENDPOINT_ID_EARS',
  'RUNPOD_ENDPOINT_ID_VOICE',
  'RUNPOD_ENDPOINT_ID_VISION',
  'RUNPOD_ENDPOINT_ID_VIDEO',
  // Der Brain-Warmup nimmt bei gesetzter URL den OpenAI-Pfad statt `warmup`.
  'RUNPOD_BRAIN_OPENAI_URL',
  'RUNPOD_BRAIN_MODEL',
  'AI_FLEET_WAKE',
  'AI_FLEET_SLEEP',
] as const;

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

let calls: RecordedCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes('rest.runpod.io')) return jsonResponse({ workersMin: 1 });
      if (url.endsWith('/run')) return jsonResponse({ id: 'job-warm' });
      return jsonResponse({ status: 'COMPLETED', output: { ready: true, role: 'x' } });
    }),
  );
}

function configureFleet(): void {
  process.env.RUNPOD_API_KEY = 'rp_test';
  process.env.RUNPOD_ENDPOINT_ID_BRAIN = 'brain-ep';
  process.env.RUNPOD_ENDPOINT_ID_EARS = 'ears-ep';
  process.env.RUNPOD_ENDPOINT_ID_VOICE = 'voice-ep';
}

describe('GPU-Flotten Session-Wake', () => {
  beforeEach(() => {
    calls = [];
    __resetFleetWakeState();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetFleetWakeState();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('weckt alle drei Rollen (workersMin + Warmup) und meldet ok', async () => {
    configureFleet();
    mockFetch();

    const report = await wakeFleet();

    expect(report.action).toBe('wake');
    expect(report.ok).toBe(true);
    expect(report.roles.map((r) => r.role)).toEqual(['brain', 'ears', 'voiceGen']);
    expect(report.roles.every((r) => r.workersMinSet)).toBe(true);
    expect(report.roles.every((r) => r.warmup?.ok === true)).toBe(true);

    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(3);
    expect(patches.map((p) => p.url).sort()).toEqual([
      'https://rest.runpod.io/v1/endpoints/brain-ep',
      'https://rest.runpod.io/v1/endpoints/ears-ep',
      'https://rest.runpod.io/v1/endpoints/voice-ep',
    ]);
    expect(patches.every((p) => (p.body as { workersMin: number }).workersMin === 1)).toBe(true);

    // Pro Rolle genau ein Warmup-Job auf dem Rollen-Endpoint.
    const runs = calls.filter((c) => c.url.endsWith('/run'));
    expect(runs.map((r) => r.url).sort()).toEqual([
      'https://api.runpod.ai/v2/brain-ep/run',
      'https://api.runpod.ai/v2/ears-ep/run',
      'https://api.runpod.ai/v2/voice-ep/run',
    ]);
    expect((runs[0].body as { input: { task: string } }).input.task).toBe('warmup');
  });

  it('schaltet beim Brain-Warmup über den OpenAI-Pfad das Reasoning ab', async () => {
    configureFleet();
    process.env.RUNPOD_BRAIN_OPENAI_URL = 'https://api.runpod.ai/v2/brain-ep/openai/v1';
    mockFetch();

    const report = await wakeFleet();

    expect(report.roles.find((r) => r.role === 'brain')?.warmup?.ok).toBe(true);
    const chat = calls.find((c) => c.url.endsWith('/chat/completions'));
    expect(chat?.method).toBe('POST');
    // Ohne dieses Feld liefert der rohe vLLM-OpenAI-Pfad Reasoning-Tokens
    // (live belegt 2026-09-12: Antwort begann mit "<think>") – das Muster ist
    // mit `LlmRouter.ts` identisch.
    expect((chat?.body as { chat_template_kwargs?: unknown }).chat_template_kwargs)
      .toEqual({ enable_thinking: false });
    // Der Warmup bleibt minimal.
    expect((chat?.body as { max_tokens: number }).max_tokens).toBe(1);
  });

  it('meldet nicht konfigurierte Rollen, ohne Netzwerk zu benutzen', async () => {
    mockFetch();
    const report = await wakeFleet();

    expect(calls).toHaveLength(0);
    expect(report.roles.every((r) => !r.configured)).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('fällt auf RUNPOD_ENDPOINT_ID zurück (Legacy-Modus)', async () => {
    process.env.RUNPOD_API_KEY = 'rp_test';
    process.env.RUNPOD_ENDPOINT_ID = 'legacy-ep';
    mockFetch();

    const report = await wakeFleet();
    const runs = calls.filter((c) => c.url.endsWith('/run'));
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.url === 'https://api.runpod.ai/v2/legacy-ep/run')).toBe(true);
    expect(report.roles.every((r) => r.configured)).toBe(true);
  });

  it('tut mit AI_FLEET_WAKE=0 nichts', async () => {
    configureFleet();
    process.env.AI_FLEET_WAKE = '0';
    mockFetch();

    const report = await wakeFleet();
    expect(calls).toHaveLength(0);
    expect(report.roles.every((r) => r.error === 'AI_FLEET_WAKE disabled')).toBe(true);
  });

  it('legt die Flotte mit workersMin=0 schlafen', async () => {
    configureFleet();
    mockFetch();

    const report = await sleepFleet();
    expect(report.ok).toBe(true);
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(3);
    expect(patches.every((p) => (p.body as { workersMin: number }).workersMin === 0)).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/run'))).toBe(false);
  });

  it('bündelt parallele Wake-Aufrufe zu einem Lauf', async () => {
    configureFleet();
    mockFetch();

    const [a, b] = await Promise.all([wakeFleet(), wakeFleet()]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c.url.endsWith('/run'))).toHaveLength(3);
  });

  it('liefert den Rollen-Status ohne Netzwerkaufruf', () => {
    configureFleet();
    mockFetch();

    const status = fleetStatus() as { roles: Array<Record<string, unknown>>; credentialConfigured: boolean };
    expect(status.credentialConfigured).toBe(true);
    expect(status.roles.map((r) => r.role)).toEqual(['brain', 'ears', 'voiceGen']);
    expect(status.roles.every((r) => r.configured)).toBe(true);
    expect(status.roles.map((r) => r.endpointName)).toEqual([
      'samplemonk-ai-brain',
      'samplemonk-ai-ears',
      'samplemonk-ai-voice',
    ]);
    expect(calls).toHaveLength(0);
  });

  it('weckt die Rolle vision per workersMin (kein warmup-Task)', async () => {
    configureFleet();
    process.env.RUNPOD_ENDPOINT_ID_VISION = 'vision-ep';
    mockFetch();

    const report = await wakeFleet();

    expect(report.vision).toEqual({ endpointId: 'vision-ep', workersMinSet: true });
    const visionPatch = calls.find((c) => c.url === 'https://rest.runpod.io/v1/endpoints/vision-ep');
    expect(visionPatch?.method).toBe('PATCH');
    expect((visionPatch?.body as { workersMin: number }).workersMin).toBe(1);
    // Vision bekommt KEINEN warmup-Job.
    expect(calls.some((c) => c.url.includes('/v2/vision-ep/run'))).toBe(false);
  });

  it('schläfert die Rolle vision mit workersMin=0', async () => {
    configureFleet();
    process.env.RUNPOD_ENDPOINT_ID_VISION = 'vision-ep';
    mockFetch();

    const report = await sleepFleet();
    expect(report.vision?.workersMinSet).toBe(true);
    const visionPatch = calls.find((c) => c.url === 'https://rest.runpod.io/v1/endpoints/vision-ep');
    expect((visionPatch?.body as { workersMin: number }).workersMin).toBe(0);
  });

  it('weckt die Rolle video per workersMin (kein warmup-Task)', async () => {
    configureFleet();
    process.env.RUNPOD_ENDPOINT_ID_VIDEO = 'video-ep';
    mockFetch();

    const report = await wakeFleet();
    expect(report.video).toEqual({ endpointId: 'video-ep', workersMinSet: true });
    const patch = calls.find((c) => c.url === 'https://rest.runpod.io/v1/endpoints/video-ep');
    expect((patch?.body as { workersMin: number }).workersMin).toBe(1);
  });
});
