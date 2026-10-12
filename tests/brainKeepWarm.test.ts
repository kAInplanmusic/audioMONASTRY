/**
 * RT-AUDIT-P1-015 · Kein Kaltstart während aktiver Session (Log-Nachweis).
 *
 * Ablauf, wie ihn der Realtime-Hub meldet (onPresenceChange):
 *   erster Join → Brain wecken (workersMin=1 + Warmup) →
 *   AI-Idle-Timer will schlafen legen → UNTERDRÜCKT (Log) →
 *   letzter Leave → Karenz 15 min → sleepFleet (workersMin=0) → Log.
 * Rejoin innerhalb der Karenz: kein neuer Wake, kein Sleep (Brain bleibt warm).
 */
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
import { resetBudgetLimits, setBudgetLimits } from '../src/config/aiInfrastructure';
import { AiOrchestrator } from '../src/core/ai/orchestrator/aiOrchestrator';

const ENV_KEYS = [
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

function mockFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('rest.runpod.io')) return json({ workersMin: 1 });
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
const patches = (workersMin: number) => calls.filter((c) => c.method === 'PATCH' && (c.body as { workersMin?: number })?.workersMin === workersMin);

describe('Brain warm halten während aktiver Studio-Session (RT-AUDIT-P1-015)', () => {
  beforeEach(() => {
    calls = [];
    logLines = [];
    __resetFleetWakeState();
    __resetAiGate();
    resetBudgetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
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

  it('erster Join weckt NUR den Brain (workersMin=1 + Warmup), weitere Joins wecken nicht erneut', async () => {
    const report = await onStudioPresence(1);
    expect(report?.blocked).toBeNull();
    expect(patches(1).map((c) => c.url)).toEqual([expect.stringContaining('/endpoints/brain-ep')]);
    expect(calls.some((c) => c.url.includes('ears-ep'))).toBe(false);
    expect(brainKeepWarmStatus()).toMatchObject({ members: 1, warm: true, sleepScheduled: false });

    const before = calls.length;
    expect(onStudioPresence(2)).toBeNull();
    expect(onStudioPresence(3)).toBeNull();
    expect(calls.length).toBe(before);
    expect(keepWarmLogs()).toEqual([
      'brain keep-warm: first member joined, waking brain',
      'brain keep-warm: wake result',
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
    expect(onStudioPresence(1)).toBeNull(); // Rejoin: kein neuer Wake
    expect(patches(1).length).toBe(wakesBefore);
    expect(brainKeepWarmStatus()).toMatchObject({ warm: true, sleepScheduled: false });

    onStudioPresence(0);
    await vi.advanceTimersByTimeAsync(900_000 - 1);
    expect(patches(0)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(patches(0).length).toBeGreaterThan(0);
    expect(patches(0).map((c) => c.url)).toContain('https://rest.runpod.io/v1/endpoints/brain-ep');
    expect(brainKeepWarmStatus().warm).toBe(false);
    expect(keepWarmLogs()).toEqual([
      'brain keep-warm: first member joined, waking brain',
      'brain keep-warm: wake result',
      'brain keep-warm: last member left, sleep scheduled',
      'brain keep-warm: rejoin within grace, sleep cancelled',
      'brain keep-warm: last member left, sleep scheduled',
      'brain keep-warm: grace elapsed, fleet asleep',
    ]);

    // Nach dem Sleep weckt der nächste erste Join wieder.
    await onStudioPresence(1);
    expect(patches(1).length).toBe(wakesBefore + 1);
  });

  it('respektiert AI-Schalter und Budget (kein RunPod-Aufruf)', async () => {
    setAiOperatingMode('off');
    const off = await onStudioPresence(1);
    expect(off?.blocked).toBe('ai-off');
    expect(calls).toHaveLength(0);
    expect(brainKeepWarmStatus().warm).toBe(false);

    __resetFleetWakeState();
    __resetAiGate();
    setBudgetLimits({ maxEurPerHour: 0.01 });
    const budget = await onStudioPresence(1);
    expect(budget?.blocked).toBe('budget');
    expect(calls).toHaveLength(0);
  });

  it('Status zeigt das Warmhalten', async () => {
    await onStudioPresence(1);
    expect((fleetStatus() as { brainKeepWarm: unknown }).brainKeepWarm).toMatchObject({ members: 1, warm: true, graceMs: 900_000 });
  });
});
