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
  'RP_AGENT_KEY',
  'RUNPOD_REST_BASE',
  'RUNPOD_API_BASE',
  'RUNPOD_ENDPOINT_ID',
  'RUNPOD_ENDPOINT_ID_BRAIN',
  'RUNPOD_ENDPOINT_ID_EARS',
  'RUNPOD_ENDPOINT_ID_VOICE',
  'RUNPOD_ENDPOINT_ID_MUSIC',
  'RUNPOD_ENDPOINT_ID_IMAGE',
  'RUNPOD_ENDPOINT_ID_VIDEO_REAL',
  'RUNPOD_ENDPOINT_ID_VIDEO_ABSTRACT',
  'RUNPOD_ENDPOINT_ID_ORCHESTRATOR',
  'RP_ENDPOINT_ID',
  'RP_ENDPOINT_ID_BRAIN',
  'RP_ENDPOINT_ID_EARS',
  'RP_ENDPOINT_ID_VOICE',
  'RP_ENDPOINT_ID_MUSIC',
  'RP_ENDPOINT_ID_IMAGE',
  'RP_ENDPOINT_ID_VIDEO_REAL',
  'RP_ENDPOINT_ID_VIDEO_ABSTRACT',
  'RP_ENDPOINT_ID_ORCHESTRATOR',
  // Der Brain-Warmup nimmt bei gesetzter URL den OpenAI-Pfad statt `warmup`.
  'RUNPOD_BRAIN_OPENAI_URL',
  'RP_BRAIN_OPENAI_URL',
  'RUNPOD_BRAIN_MODEL',
  'AI_FLEET_WAKE',
  'AI_FLEET_SLEEP',
] as const;

/** Alle acht Rollen der 8-Instanzen-Flotte in Anzeige-Reihenfolge. */
const FLEET_ROLES = [
  'brain',
  'ears',
  'voiceGen',
  'music',
  'imageHq',
  'videoReal',
  'videoAbstract',
  'orchestrator',
] as const;

/** Rollen mit `warmupMode: 'task'` – sie bekommen einen warmup-Job. */
const TASK_ROLES = new Set(['brain', 'ears', 'voiceGen', 'orchestrator']);

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
  process.env.RP_AGENT_KEY = 'rp_test';
  process.env.RP_ENDPOINT_ID_BRAIN = 'brain-ep';
  process.env.RP_ENDPOINT_ID_EARS = 'ears-ep';
  process.env.RP_ENDPOINT_ID_VOICE = 'voice-ep';
  process.env.RP_ENDPOINT_ID_MUSIC = 'music-ep';
  process.env.RP_ENDPOINT_ID_IMAGE = 'image-ep';
  process.env.RP_ENDPOINT_ID_VIDEO_REAL = 'video-real-ep';
  process.env.RP_ENDPOINT_ID_VIDEO_ABSTRACT = 'video-abstract-ep';
  process.env.RP_ENDPOINT_ID_ORCHESTRATOR = 'orchestrator-ep';
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

  it('weckt alle acht Rollen und meldet ok', async () => {
    configureFleet();
    mockFetch();

    const report = await wakeFleet();

    expect(report.action).toBe('wake');
    expect(report.ok).toBe(true);
    expect(report.roles.map((r) => r.role)).toEqual([...FLEET_ROLES]);
    expect(report.roles.every((r) => r.workersMinSet)).toBe(true);

    // Jede der acht Rollen bekommt genau ein workersMin=1-PATCH.
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(8);
    expect(patches.every((p) => (p.body as { workersMin: number }).workersMin === 1)).toBe(true);

    // Nur die vier Task-Rollen feuern einen Warmup-Job – die visuellen
    // Prebuilt-Worker (music/image/video) kennen den `warmup`-Task nicht.
    const runs = calls.filter((c) => c.url.endsWith('/run'));
    expect(runs).toHaveLength(4);
    expect((runs[0].body as { input: { task: string } }).input.task).toBe('warmup');
    for (const role of ['image', 'video-real', 'video-abstract', 'music']) {
      expect(calls.some((c) => c.url.includes(`/v2/${role}-ep/run`))).toBe(false);
    }
  });

  it('markiert die Warmup-Modi je Rolle', async () => {
    configureFleet();
    mockFetch();

    const report = await wakeFleet();

    for (const status of report.roles) {
      const expected = TASK_ROLES.has(status.role) ? 'task' : 'endpoint';
      expect(status.warmupMode, status.role).toBe(expected);
    }
    // Task-Rollen haben ein Warmup-Ergebnis, Endpoint-Rollen nicht.
    expect(report.roles.filter((r) => r.warmupMode === 'task').every((r) => r.warmup?.ok === true)).toBe(true);
    expect(report.roles.filter((r) => r.warmupMode === 'endpoint').every((r) => r.warmup === null)).toBe(true);
  });

  it('schaltet beim Brain-Warmup über den OpenAI-Pfad das Reasoning ab', async () => {
    configureFleet();
    process.env.RP_BRAIN_OPENAI_URL = 'https://api.runpod.ai/v2/brain-ep/openai/v1';
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
    expect(report.roles).toHaveLength(8);
    expect(report.roles.every((r) => !r.configured)).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('fällt auf RP_ENDPOINT_ID zurück (Legacy-Modus)', async () => {
    process.env.RP_AGENT_KEY = 'rp_test';
    process.env.RP_ENDPOINT_ID = 'legacy-ep';
    mockFetch();

    const report = await wakeFleet();
    const runs = calls.filter((c) => c.url.endsWith('/run'));
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.url === 'https://api.runpod.ai/v2/legacy-ep/run')).toBe(true);
    expect(report.roles).toHaveLength(8);
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
    expect(patches).toHaveLength(8);
    expect(patches.every((p) => (p.body as { workersMin: number }).workersMin === 0)).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/run'))).toBe(false);
  });

  it('bündelt parallele Wake-Aufrufe zu einem Lauf', async () => {
    configureFleet();
    mockFetch();

    const [a, b] = await Promise.all([wakeFleet(), wakeFleet()]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c.url.endsWith('/run'))).toHaveLength(4);
  });

  it('liefert den Rollen-Status ohne Netzwerkaufruf', () => {
    configureFleet();
    mockFetch();

    const status = fleetStatus() as { roles: Array<Record<string, unknown>>; credentialConfigured: boolean };
    expect(status.credentialConfigured).toBe(true);
    expect(status.roles.map((r) => r.role)).toEqual([...FLEET_ROLES]);
    expect(status.roles.every((r) => r.configured)).toBe(true);
    expect(status.roles.map((r) => r.endpointName)).toEqual([
      'samplemonk-ai-brain',
      'samplemonk-ai-ears',
      'samplemonk-ai-voice',
      'samplemonk-ai-music',
      'samplemonk-ai-image',
      'samplemonk-ai-video-real',
      'samplemonk-ai-video-abstract',
      'samplemonk-ai-orchestrator',
    ]);
    expect(calls).toHaveLength(0);
  });
});
