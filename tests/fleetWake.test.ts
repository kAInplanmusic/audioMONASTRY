import { beforeEach as beforeCompatibilityProvider, afterEach as afterCompatibilityProvider } from 'vitest';
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
import { POD_ROLE_IDS } from '../src/core/ai/orchestrator/podRouting';
import { __resetPodStartTriggers } from '../src/core/ai/orchestrator/podStartTriggers';

// Explicit compatibility fixture: production now defaults to Vast.
beforeCompatibilityProvider(() => { process.env.AI_GPU_PROVIDER = 'vast'; });
afterCompatibilityProvider(() => { delete process.env.AI_GPU_PROVIDER; });

/*
 * Vast-Flotte (Pod-Modus, seit der RunPod-Abschaltung immer aktiv):
 * "Wecken" heißt GET /ready je Pod (fleetWake.podRoleStatus) – kein
 * workersMin-PATCH und kein Warmup-Job. Die Visual-Rollen haben keinen Pod.
 * Entfallen sind die Tests des RunPod-Serverless-Wegs (workersMin=0/1 an
 * Endpoints, Legacy-Endpoint-ID, OpenAI-Warmup des Brain, Visual-Idle-Sleep
 * über Endpoints); der Pod-Auto-Stop steht in fleetAutostop.test.ts.
 */
const podKey = (pod: string) => pod.toUpperCase().replace(/-/g, '_');

const ENV_KEYS = [
  'AI_POD_TOKEN',
  'VAST_API_KEY',
  ...POD_ROLE_IDS.flatMap((pod) => [`VAST_POD_URL_${podKey(pod)}`, `VAST_POD_EUR_PER_HOUR_${podKey(pod)}`]),
  'AI_FLEET_WAKE',
  'AI_FLEET_SLEEP',
  // INFRA-FEAT-001/002: Betriebsmodus + Idle-Fenster der Visual-Rollen.
  'AI_MODE',
  'AI_OPERATING_MODE',
  'AI_VISUAL_IDLE_MS',
] as const;

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

const ALWAYS_ON_ROLES = ['brain', 'ears', 'voiceGen', 'music', 'orchestrator'] as const;

const VISUAL_ROLES = ['imageHq', 'videoReal', 'videoAbstract'] as const;

const TASK_ROLES = new Set(['brain', 'ears', 'voiceGen', 'orchestrator']);

/** Pods, die die immer-Rollen tragen (orchestrator teilt sich den brain-Pod). */
const ALWAYS_ON_PODS = ['brain', 'ears', 'voice', 'music', 'brain'];

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
      if (url.startsWith('https://console.vast.ai/api/v1/instances')) return jsonResponse({ instances: [] });
      if (url.endsWith('/ready')) return jsonResponse({ status: 'ready' });
      return jsonResponse({ error: 'unexpected' }, 500);
    }),
  );
}

function configureFleet(): void {
  process.env.AI_POD_TOKEN = 't'.repeat(32);
  for (const pod of POD_ROLE_IDS) {
    process.env[`VAST_POD_URL_${podKey(pod)}`] = `https://${pod.replace(/-/g, '')}.pods.example`;
    process.env[`VAST_POD_EUR_PER_HOUR_${podKey(pod)}`] = '0.4';
  }
}

const readyCalls = () => calls.filter((c) => c.url.endsWith('/ready'));

describe('GPU-Flotten Session-Wake (Vast-Pods)', () => {
  beforeEach(() => {
    calls = [];
    __resetFleetWakeState();
    __resetPodStartTriggers();
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

  it('weckt die immer-Rollen über /ready und lässt die Visual-Rollen unberührt (INFRA-FEAT-002)', async () => {
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
    expect(woken.every((r) => r.workersMinSet && r.warmup?.ok === true)).toBe(true);
    for (const role of VISUAL_ROLES) {
      const status = report.roles.find((r) => r.role === role);
      expect(status?.skipped).toBe(true);
      expect(status?.workersMinSet).toBe(false);
    }

    // Je immer-Rolle genau eine Bereitschaftsprobe an ihren Pod, sonst nichts:
    // kein PATCH, kein Warmup-Job.
    expect(readyCalls().map((c) => c.url)).toEqual(ALWAYS_ON_PODS.map((pod) => `https://${pod}.pods.example/ready`));
    expect(calls).toHaveLength(ALWAYS_ON_PODS.length);
  });

  it('Visual-Rolle: ohne Freigabe gesperrt, mit Freigabe ehrlich ohne Pod – kein Request', async () => {
    configureFleet();
    mockFetch();

    // Standardmodus „AI ohne Visualisierung“: angefordert, aber gesperrt.
    const blocked = await wakeFleet({ roles: ['imageHq'], purpose: 'visual-on-demand' });
    expect(blocked.blocked).toBe('visuals-off');
    expect(blocked.ok).toBe(false);
    expect(calls).toHaveLength(0);

    // Mit Visual-Freigabe: die Vast-Flotte hat keinen Bild-Pod.
    setAiOperatingMode('on-with-visuals', { source: 'test' });
    const report = await wakeFleet({ roles: ['imageHq'], purpose: 'visual-on-demand' });
    expect(report.blocked).toBeNull();
    const image = report.roles.find((r) => r.role === 'imageHq');
    expect(image).toMatchObject({ configured: false, error: 'keine Instanz für diese Rolle' });
    expect(calls).toHaveLength(0);

    // Der Bedarfs-Wake über Endpoint-IDs gehört zum Serverless-Weg: ohne
    // Endpoint-ID meldet er "nicht konfiguriert", ebenfalls ohne Request.
    const onDemand = await wakeRoleOnDemand('imageHq');
    expect(onDemand?.configured).toBe(false);
    expect(calls).toHaveLength(0);
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
    process.env.VAST_API_KEY = 'vk_test';
    setAiOperatingMode('off', { source: 'test' });
    mockFetch();

    const report = await sleepFleet();

    // Pod-Modus: sleepFleet läuft über den Auto-Stop – trotz „AI aus“.
    expect(report.autostop).toMatchObject({ reason: 'sleep-fleet' });
    expect(calls.some((c) => c.url.startsWith('https://console.vast.ai/api/v1/instances'))).toBe(true);
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
    expect(readyCalls()).toHaveLength(ALWAYS_ON_PODS.length);
  });

  it('markiert die Warmup-Modi je Rolle', async () => {
    configureFleet();
    mockFetch();

    const report = await wakeFleet();

    for (const status of report.roles.filter((r) => !r.skipped)) {
      const expected = TASK_ROLES.has(status.role) ? 'task' : 'endpoint';
      expect(status.warmupMode, status.role).toBe(expected);
      // Pod-Modus: das Bereitschaftsergebnis steht im Warmup-Feld.
      expect(status.warmup?.ok, status.role).toBe(true);
    }
  });

  it('meldet einen nicht bereiten Pod, ohne den Lauf abzubrechen', async () => {
    configureFleet();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url, method: 'GET', body: undefined });
      return url === 'https://ears.pods.example/ready' ? jsonResponse({ status: 'loading' }, 503) : jsonResponse({ status: 'ready' });
    }));

    const report = await wakeFleet();

    const ears = report.roles.find((r) => r.role === 'ears');
    expect(ears?.workersMinSet).toBe(false);
    expect(ears?.warmup).toMatchObject({ ok: false, message: 'Pod ears: 503' });
    expect(report.roles.find((r) => r.role === 'brain')?.warmup?.ok).toBe(true);
  });

  it('meldet nicht konfigurierte Rollen, ohne Netzwerk zu benutzen', async () => {
    mockFetch();
    const report = await wakeFleet();

    expect(calls).toHaveLength(0);
    expect(report.roles).toHaveLength(8);
    expect(report.roles.every((r) => !r.configured)).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('tut mit AI_FLEET_WAKE=0 nichts', async () => {
    configureFleet();
    process.env.AI_FLEET_WAKE = '0';
    mockFetch();

    const report = await wakeFleet();
    expect(calls).toHaveLength(0);
    expect(report.roles.every((r) => r.error === 'AI_FLEET_WAKE disabled')).toBe(true);
  });

  it('bündelt parallele Wake-Aufrufe zu einem Lauf', async () => {
    configureFleet();
    mockFetch();

    const [a, b] = await Promise.all([wakeFleet(), wakeFleet()]);
    expect(a).toBe(b);
    expect(readyCalls()).toHaveLength(ALWAYS_ON_PODS.length);
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
