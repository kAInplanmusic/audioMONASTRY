import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFleetWakeState,
  fleetStatus,
  sessionWakeRoles,
  sleepFleet,
  wakeFleet,
  wakeRoleOnDemand,
} from '../src/core/ai/orchestrator/fleetWake';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';
import { resetBudgetLimits, setBudgetLimits } from '../src/config/aiInfrastructure';

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
  // INFRA-FEAT-001/002: Betriebsmodus + Idle-Fenster der Visual-Rollen.
  'AI_MODE',
  'AI_OPERATING_MODE',
  'AI_VISUAL_IDLE_MS',
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

/** Immer-Rollen (alles außer den Visual-Rollen) – Scope eines Session-Wakes. */
const ALWAYS_ON_ROLES = ['brain', 'ears', 'voiceGen', 'music', 'orchestrator'] as const;

/** Visual-Rollen – starten nur bei Abruf (Konstitution §2). */
const VISUAL_ROLES = ['imageHq', 'videoReal', 'videoAbstract'] as const;

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
    __resetAiGate();
    resetBudgetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetFleetWakeState();
    __resetAiGate();
    resetBudgetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('weckt die immer-Rollen und lässt die Visual-Rollen unberührt (INFRA-FEAT-002)', async () => {
    configureFleet();
    mockFetch();

    const report = await wakeFleet();

    expect(report.action).toBe('wake');
    expect(report.ok).toBe(true);
    expect(report.blocked).toBeNull();
    // Der Bericht listet die ganze Flotte, geweckt wird aber nur der Immer-Teil.
    expect(report.roles.map((r) => r.role)).toEqual([...FLEET_ROLES]);
    expect(sessionWakeRoles()).toEqual([...ALWAYS_ON_ROLES]);

    const woken = report.roles.filter((r) => !r.skipped);
    expect(woken.map((r) => r.role)).toEqual([...ALWAYS_ON_ROLES]);
    expect(woken.every((r) => r.workersMinSet)).toBe(true);
    for (const role of VISUAL_ROLES) {
      const status = report.roles.find((r) => r.role === role);
      expect(status?.skipped).toBe(true);
      expect(status?.workersMinSet).toBe(false);
    }

    // Fünf workersMin=1-PATCHes – kein einziger für eine Visual-Rolle.
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(ALWAYS_ON_ROLES.length);
    expect(patches.every((p) => (p.body as { workersMin: number }).workersMin === 1)).toBe(true);
    for (const role of ['image', 'video-real', 'video-abstract']) {
      expect(calls.some((c) => c.url.includes(`/v2/${role}-ep/`))).toBe(false);
    }

    // Nur die vier Task-Rollen feuern einen Warmup-Job – die visuellen
    // Prebuilt-Worker (music/image/video) kennen den `warmup`-Task nicht.
    const runs = calls.filter((c) => c.url.endsWith('/run'));
    expect(runs).toHaveLength(4);
    expect((runs[0].body as { input: { task: string } }).input.task).toBe('warmup');
  });

  it('startet eine Visual-Rolle nur bei Abruf und nur mit Visual-Freigabe', async () => {
    configureFleet();
    mockFetch();

    // Standardmodus „AI ohne Visualisierung“: angefordert, aber gesperrt.
    const blocked = await wakeFleet({ roles: ['imageHq'], purpose: 'visual-on-demand' });
    expect(blocked.blocked).toBe('visuals-off');
    expect(blocked.ok).toBe(false);
    expect(calls).toHaveLength(0);

    // Mit Visual-Freigabe startet GENAU die angeforderte Rolle.
    setAiOperatingMode('on-with-visuals', { source: 'test' });
    const report = await wakeFleet({ roles: ['imageHq'], purpose: 'visual-on-demand' });
    expect(report.blocked).toBeNull();
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe('https://rest.runpod.io/v1/endpoints/image-ep');
    // Endpoint-Rolle: kein warmup-Job.
    expect(calls.some((c) => c.url.endsWith('/run'))).toBe(false);
  });

  it('weckt eine Visual-Rolle bedarfsgesteuert und legt sie per Idle-Timer schlafen', async () => {
    configureFleet();
    process.env.AI_VISUAL_IDLE_MS = '0';
    setAiOperatingMode('on-with-visuals', { source: 'test' });
    mockFetch();

    const status = await wakeRoleOnDemand('imageHq');
    expect(status?.workersMinSet).toBe(true);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);

    // Idle-Fenster 0 → der Timer setzt dieselbe Rolle wieder auf workersMin=0.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect((patches[1].body as { workersMin: number }).workersMin).toBe(0);
  });

  it('startet bei „AI aus“ gar nichts (INFRA-FEAT-001)', async () => {
    configureFleet();
    setAiOperatingMode('off', { source: 'test' });
    mockFetch();

    const report = await wakeFleet();

    expect(calls).toHaveLength(0);
    expect(report.ok).toBe(false);
    expect(report.blocked).toBe('ai-off');
    expect(report.roles.every((r) => r.workersMinSet === false)).toBe(true);
    expect(report.reason).toMatch(/nur Hetzner-Kosten/);

    // Auch ein ausdrücklicher Visual-Abruf weckt nichts.
    const visual = await wakeFleet({ roles: ['imageHq'], purpose: 'visual-on-demand' });
    expect(visual.blocked).toBe('ai-off');
    expect(calls).toHaveLength(0);
  });

  it('legt die Flotte auch bei „AI aus“ schlafen (Kosten senken bleibt erlaubt)', async () => {
    configureFleet();
    setAiOperatingMode('off', { source: 'test' });
    mockFetch();

    const report = await sleepFleet();

    expect(report.ok).toBe(true);
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(FLEET_ROLES.length);
    expect(patches.every((p) => (p.body as { workersMin: number }).workersMin === 0)).toBe(true);
  });

  it('blockt den Wake, wenn das Stundenbudget gerissen ist (INFRA-FEAT-003)', async () => {
    configureFleet();
    // Laufzeit-Grenze unter die Kosten der immer-Rollen senken.
    setBudgetLimits({ maxEurPerHour: 1 });
    mockFetch();

    const report = await wakeFleet();

    expect(calls).toHaveLength(0);
    expect(report.ok).toBe(false);
    expect(report.blocked).toBe('budget');
    expect(report.reason).toMatch(/übersteigen das Budget/);

    // Gegenprobe: mit dem Konstitutions-Budget läuft derselbe Wake.
    resetBudgetLimits();
    const ok = await wakeFleet();
    expect(ok.blocked).toBeNull();
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(ALWAYS_ON_ROLES.length);
  });

  it('markiert die Warmup-Modi je Rolle', async () => {
    configureFleet();
    mockFetch();

    const report = await wakeFleet();

    for (const status of report.roles.filter((r) => !r.skipped)) {
      const expected = TASK_ROLES.has(status.role) ? 'task' : 'endpoint';
      expect(status.warmupMode, status.role).toBe(expected);
    }
    // Task-Rollen haben ein Warmup-Ergebnis, Endpoint-Rollen nicht.
    expect(report.roles.filter((r) => r.warmupMode === 'task' && !r.skipped).every((r) => r.warmup?.ok === true)).toBe(true);
    expect(report.roles.filter((r) => r.warmupMode === 'endpoint' && !r.skipped).every((r) => r.warmup === null)).toBe(true);
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

  it('liefert den Rollen-Status inkl. Modus und Budget ohne Netzwerkaufruf', () => {
    configureFleet();
    mockFetch();

    const status = fleetStatus() as {
      roles: Array<Record<string, unknown>>;
      credentialConfigured: boolean;
      aiMode: string;
      aiEnabled: boolean;
      visualsEnabled: boolean;
      allowedRoles: string[];
      blockedRoles: string[];
      budget: { totalEurPerHour: number; withinLimit: boolean; storage: { withinLimit: boolean } };
    };
    expect(status.credentialConfigured).toBe(true);
    expect(status.roles.map((r) => r.role)).toEqual([...FLEET_ROLES]);
    expect(status.roles.every((r) => r.configured)).toBe(true);
    expect(status.roles.map((r) => r.endpointName)).toEqual([
      'audiomonastry-ai-brain',
      'audiomonastry-ai-ears',
      'audiomonastry-ai-voice',
      'audiomonastry-ai-music',
      'audiomonastry-ai-image',
      'audiomonastry-ai-video-real',
      'audiomonastry-ai-video-abstract',
      'audiomonastry-ai-orchestrator',
    ]);
    // Default = „AI an, ohne Visualisierung“.
    expect(status.aiMode).toBe('on-no-visuals');
    expect(status.aiEnabled).toBe(true);
    expect(status.visualsEnabled).toBe(false);
    expect(status.allowedRoles).toEqual([...ALWAYS_ON_ROLES]);
    expect(status.blockedRoles).toEqual([...VISUAL_ROLES]);
    // 5 immer-Rollen à 0,49 €/h + Hetzner 0,054 €/h.
    expect(status.budget.totalEurPerHour).toBeCloseTo(2.504, 3);
    expect(status.budget.withinLimit).toBe(true);
    expect(status.budget.storage.withinLimit).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
