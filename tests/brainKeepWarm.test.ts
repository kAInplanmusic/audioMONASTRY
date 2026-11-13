/**
 * RT-AUDIT-P1-015 · Kein Kaltstart während aktiver Session (Log-Nachweis).
 *
 * Ablauf, wie ihn der Realtime-Hub meldet (onPresenceChange):
 *   erster Join → Brain wecken (workersMin=1 + Warmup) →
 *   AI-Idle-Timer will schlafen legen → UNTERDRÜCKT (Log) →
 *   letzter Leave → Karenz 15 min → sleepFleet (workersMin=0) → Log.
 * Rejoin innerhalb der Karenz: kein neuer Wake, kein Sleep (Brain bleibt warm).
 */
import { beforeEach as beforeCompatibilityProvider, afterEach as afterCompatibilityProvider } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFleetWakeState,
  brainKeepWarmGraceMs,
  brainKeepWarmStatus,
  fleetStatus,
  isStudioSessionActive,
  onStudioPresence,
  shouldSuppressScaleToZero,
} from '../src/core/ai/orchestrator/fleetWake';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';
import { resetBudgetLimits } from '../src/config/aiInfrastructure';
import { AiOrchestrator } from '../src/core/ai/orchestrator/aiOrchestrator';
import { POD_ROLE_IDS } from '../src/core/ai/orchestrator/podRouting';
import { setFleetAutostopHooks } from '../src/core/ai/orchestrator/fleetAutostop';

// Explicit compatibility fixture: production now defaults to Vast.
beforeCompatibilityProvider(() => { process.env.AI_GPU_PROVIDER = 'vast'; });
afterCompatibilityProvider(() => { delete process.env.AI_GPU_PROVIDER; });

const ENV_KEYS = [
  'VAST_API_KEY', 'AI_POD_TOKEN', ...POD_ROLE_IDS.flatMap(role => [`VAST_POD_URL_${role.toUpperCase().replace(/-/g, '_')}`, `VAST_POD_EUR_PER_HOUR_${role.toUpperCase().replace(/-/g, '_')}`]),
  'RP_AGENT_KEY', 'RP_API_KEY', 'RUNPOD_API_KEY', 'RUNPOD_REST_BASE',
  'RP_ENDPOINT_ID', 'RP_ENDPOINT_ID_BRAIN', 'RP_ENDPOINT_ID_EARS', 'RP_ENDPOINT_ID_VOICE',
  'RP_ENDPOINT_ID_MUSIC', 'RP_ENDPOINT_ID_IMAGE', 'RP_ENDPOINT_ID_VIDEO_REAL',
  'RP_ENDPOINT_ID_VIDEO_ABSTRACT', 'RP_ENDPOINT_ID_ORCHESTRATOR',
  'RUNPOD_BRAIN_OPENAI_URL', 'RP_BRAIN_OPENAI_URL', 'RUNPOD_BRAIN_MODEL',
  'AI_FLEET_WAKE', 'AI_FLEET_SLEEP', 'AI_MODE', 'AI_OPERATING_MODE', 'AI_BRAIN_KEEPWARM_GRACE_MS',
] as const;

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let logLines: Array<Record<string, unknown>> = [];
let instances: Array<{ id: number; label: string; actual_status: string }> = [];

function mockFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://console.vast.ai/api/v1/instances?')) return json({ instances });
    if (init?.method === 'DELETE') { instances = instances.filter(instance => !url.endsWith(`/${instance.id}/`)); return json({ success: true }); }
    if (url.endsWith('/ready')) return json({ status: 'ready' });
    if (url.endsWith('/run')) return json({ id: 'job-warm' });
    return json({ status: 'COMPLETED', output: { ready: true, role: 'brain' } });
  }));
}

function captureLogs(): void {
  const grab = (line: unknown) => {
    try { logLines.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* fremde Zeile */ }
  };
  vi.spyOn(console, 'log').mockImplementation(grab);
  vi.spyOn(console, 'warn').mockImplementation(grab);
  vi.spyOn(console, 'error').mockImplementation(grab);
}

const keepWarmLogs = () => logLines.map((l) => String(l.msg)).filter((m) => m.startsWith('brain keep-warm'));
const patches = (workersMin: number) => calls.filter(c => workersMin === 1 ? c.method === 'GET' && c.url.endsWith('/ready') : c.method === 'DELETE');

describe('Brain warm halten während aktiver Studio-Session (RT-AUDIT-P1-015)', () => {
  beforeEach(() => {
    calls = [];
    logLines = [];
    __resetFleetWakeState();
    __resetAiGate();
    resetBudgetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.VAST_API_KEY = 'fixture-control-key';
    process.env.AI_POD_TOKEN = 'fixture-runtime-token-with-thirty-two-characters';
    for (const role of POD_ROLE_IDS) {
      const suffix = role.toUpperCase().replace(/-/g, '_');
      process.env[`VAST_POD_URL_${suffix}`] = `https://${role}.example`;
      process.env[`VAST_POD_EUR_PER_HOUR_${suffix}`] = '.5';
    }
    instances = POD_ROLE_IDS.map((role, i) => ({ id: 10000 + i, label: `audiomonastry-vast-${role}`, actual_status: 'running' }));
    setFleetAutostopHooks({ checkpoint: async () => ({ ok: true, verified: true, snapshotId: 'fixture', revision: 1, persistence: 'MemorySessionPersistence' }) });
    process.env.RP_AGENT_KEY = 'rp_test';
    process.env.RP_ENDPOINT_ID_BRAIN = 'brain-ep';
    process.env.RP_ENDPOINT_ID_EARS = 'ears-ep';
    mockFetch();
    captureLogs();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetFleetWakeState();
    __resetAiGate();
    resetBudgetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('Default-Karenz ist 15 min, per Env einstellbar', () => {
    expect(brainKeepWarmGraceMs()).toBe(900_000);
    process.env.AI_BRAIN_KEEPWARM_GRACE_MS = '60000';
    expect(brainKeepWarmGraceMs()).toBe(60_000);
  });

  it('erster Join prueft alle acht ausgewaehlten Pods; weitere Joins wecken nicht erneut', async () => {
    const report = await onStudioPresence(1);
    expect(report?.blocked).toBeNull();
    expect(patches(1).map(c => c.url)).toEqual(POD_ROLE_IDS.map(role => `https://${role}.example/ready`));
    expect(calls.some(c => c.url === 'https://ears.example/ready')).toBe(true);
    expect(brainKeepWarmStatus()).toMatchObject({ members: 1, warm: true, sleepScheduled: false });

    const before = calls.length;
    expect(onStudioPresence(2)).toBeNull();
    expect(onStudioPresence(3)).toBeNull();
    expect(calls.length).toBe(before);
    expect(keepWarmLogs()).toEqual([
      'brain keep-warm: first member joined, starting always-on pods',
      'brain keep-warm: pod wake result',
    ]);
  });

  it('AI-Idle-Timeout während aktiver Session legt NICHT schlafen (Log-Nachweis), ohne Session schon', async () => {
    vi.useFakeTimers();
    const orchestrator = new AiOrchestrator({ sessionIdleTimeoutMs: 1_000 });
    await onStudioPresence(2);
    orchestrator.sessions.transition('STARTING');
    orchestrator.sessions.transition('WAKING_GPU');
    orchestrator.sessions.transition('LOADING_MODELS');
    orchestrator.sessions.transition('READY');
    orchestrator.sessions.transition('ACTIVE');

    await vi.advanceTimersByTimeAsync(1_500); // AI-Idle-Timer feuert
    expect(patches(0)).toHaveLength(0);
    expect(keepWarmLogs()).toContain('brain keep-warm: scale-to-zero suppressed (studio session active)');
    const suppressed = logLines.find((l) => l.msg === 'brain keep-warm: scale-to-zero suppressed (studio session active)');
    expect(suppressed).toMatchObject({ source: 'ai-session-idle', members: 2 });

    // Gegenprobe: ohne Studio-Mitglieder greift der Idle-Timer wie bisher.
    __resetFleetWakeState();
    expect(isStudioSessionActive()).toBe(false);
    expect(shouldSuppressScaleToZero()).toBe(false);
  });

  it('letzter Leave → nach 15 min Karenz workersMin=0; Rejoin in der Karenz bricht den Sleep ab', async () => {
    vi.useFakeTimers();
    await onStudioPresence(1);
    onStudioPresence(0);
    expect(brainKeepWarmStatus().sleepScheduled).toBe(true);

    await vi.advanceTimersByTimeAsync(10 * 60_000); // 10 min: noch warm
    expect(patches(0)).toHaveLength(0);
    const wakesBefore = patches(1).length;
    await onStudioPresence(1); // Native fast path refreshes activity without another readiness probe
    expect(patches(1).length).toBe(wakesBefore);
    expect(brainKeepWarmStatus()).toMatchObject({ warm: true, sleepScheduled: false });

    onStudioPresence(0);
    await vi.advanceTimersByTimeAsync(900_000 - 1);
    expect(patches(0)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(patches(0).length).toBeGreaterThan(0);
    expect(patches(0).map((c) => c.url)).toContain('https://console.vast.ai/api/v0/instances/10000/');
    expect(brainKeepWarmStatus().warm).toBe(false);
    expect(keepWarmLogs()).toEqual([
      'brain keep-warm: first member joined, starting always-on pods',
      'brain keep-warm: pod wake result',
      'brain keep-warm: last member left, sleep scheduled',
      'brain keep-warm: rejoin within grace, sleep cancelled',
      'brain keep-warm: first member joined, starting always-on pods',
      'brain keep-warm: pod wake result',
      'brain keep-warm: last member left, sleep scheduled',
      'brain keep-warm: grace elapsed, pod autostop finished',
    ]);

    // Nach dem Sleep weckt der nächste erste Join wieder.
    await onStudioPresence(1);
    expect(patches(1).length).toBe(wakesBefore + POD_ROLE_IDS.length);
  });

  it('respektiert AI-Schalter und Budget (kein RunPod-Aufruf)', async () => {
    setAiOperatingMode('off');
    const off = await onStudioPresence(1);
    expect(off?.blocked).toBe('ai-off');
    expect(calls).toHaveLength(0);
    expect(brainKeepWarmStatus().warm).toBe(false);

    __resetFleetWakeState();
    __resetAiGate();
    for (const role of POD_ROLE_IDS) process.env[`VAST_POD_EUR_PER_HOUR_${role.toUpperCase().replace(/-/g, '_')}`] = '2';
    const budget = await onStudioPresence(1);
    expect(budget?.blocked).toBe('budget');
    expect(calls).toHaveLength(0);
  });

  it('Status zeigt das Warmhalten', async () => {
    await onStudioPresence(1);
    expect((fleetStatus() as { brainKeepWarm: unknown }).brainKeepWarm).toMatchObject({ members: 1, warm: true, graceMs: 900_000 });
  });
});
