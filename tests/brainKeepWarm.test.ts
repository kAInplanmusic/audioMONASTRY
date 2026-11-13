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

// Explicit compatibility fixture: production now defaults to Vast.
beforeCompatibilityProvider(() => { process.env.AI_GPU_PROVIDER = 'vast'; });
afterCompatibilityProvider(() => { delete process.env.AI_GPU_PROVIDER; });

const ENV_KEYS = [
  'AI_POD_TOKEN',
  ...POD_ROLE_IDS.flatMap((r) => [`VAST_POD_URL_${r.toUpperCase().replace(/-/g, '_')}`, `VAST_POD_EUR_PER_HOUR_${r.toUpperCase().replace(/-/g, '_')}`]),
  'AI_FLEET_WAKE', 'AI_FLEET_SLEEP', 'AI_FLEET_AUTOSTOP', 'AI_MAX_AI_EUR_PER_HOUR', 'AI_MODE', 'AI_OPERATING_MODE', 'AI_BRAIN_KEEPWARM_GRACE_MS',
] as const;

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let logLines: Array<Record<string, unknown>> = [];

function mockFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
/** Bereitschafts-Proben je Pod (Vast-Pod-Modus: Wecken = /ready prüfen bzw. starten). */
const readyProbes = (pod: string) => calls.filter((c) => c.url === `https://${pod}.pods.example/ready`);

describe('Brain warm halten während aktiver Studio-Session (RT-AUDIT-P1-015)', () => {
  beforeEach(() => {
    calls = [];
    logLines = [];
    __resetFleetWakeState();
    __resetAiGate();
    resetBudgetLimits();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.AI_POD_TOKEN = 't'.repeat(32);
    for (const r of POD_ROLE_IDS) {
      const key = r.toUpperCase().replace(/-/g, '_');
      process.env[`VAST_POD_URL_${key}`] = `https://${r.replace(/-/g, '')}.pods.example`;
      process.env[`VAST_POD_EUR_PER_HOUR_${key}`] = '0.4';
    }
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

  it('erster Join startet die immer-an-Pods (Brain bereit), weitere Joins wecken nicht erneut', async () => {
    const report = await onStudioPresence(1);
    expect(report?.blocked).toBeNull();
    expect(readyProbes('brain')).toHaveLength(1);
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
    // Kein Abschalten: kein Aufruf an die Vast-API (Snapshot/Terminate).
    expect(calls.filter((c) => c.url.includes('vast.ai'))).toHaveLength(0);
    expect(keepWarmLogs()).toContain('brain keep-warm: scale-to-zero suppressed (studio session active)');
    const suppressed = logLines.find((l) => l.msg === 'brain keep-warm: scale-to-zero suppressed (studio session active)');
    expect(suppressed).toMatchObject({ source: 'ai-session-idle', members: 2 });

    // Gegenprobe: ohne Studio-Mitglieder greift der Idle-Timer wie bisher.
    __resetFleetWakeState();
    expect(isStudioSessionActive()).toBe(false);
    expect(shouldSuppressScaleToZero()).toBe(false);
  });

  it('letzter Leave plant den Auto-Stop nach der Karenz; Rejoin in der Karenz bricht ihn ab', async () => {
    vi.useFakeTimers();
    await onStudioPresence(1);
    onStudioPresence(0);
    expect(brainKeepWarmStatus().sleepScheduled).toBe(true);

    await vi.advanceTimersByTimeAsync(10 * 60_000); // 10 min: noch in der Karenz
    const probesBefore = readyProbes('brain').length;
    // Rejoin: der Sleep wird abgebrochen. Im Pod-Modus prüft jeder erste Join die
    // Pods erneut (FLEET-P1-012) - bereite Pods kosten dabei nur /ready.
    await onStudioPresence(1);
    expect(brainKeepWarmStatus()).toMatchObject({ warm: true, sleepScheduled: false });
    expect(readyProbes('brain').length).toBeGreaterThanOrEqual(probesBefore);

    onStudioPresence(0);
    expect(brainKeepWarmStatus().sleepScheduled).toBe(true);
    expect(keepWarmLogs()).toEqual([
      'brain keep-warm: first member joined, starting always-on pods',
      'brain keep-warm: pod wake result',
      'brain keep-warm: last member left, sleep scheduled',
      'brain keep-warm: rejoin within grace, sleep cancelled',
      'brain keep-warm: first member joined, starting always-on pods',
      'brain keep-warm: pod wake result',
      'brain keep-warm: last member left, sleep scheduled',
    ]);
    // Was nach der Karenz passiert (Snapshot → Pods beenden), deckt
    // fleetAutostop.test.ts ab.
  });

  it('respektiert AI-Schalter und Budget (kein GPU-Aufruf)', async () => {
    setAiOperatingMode('off');
    const off = await onStudioPresence(1);
    expect(off?.blocked).toBe('ai-off');
    expect(calls).toHaveLength(0);
    expect(brainKeepWarmStatus().warm).toBe(false);

    __resetFleetWakeState();
    __resetAiGate();
    // Pod-Modus: das Budget-Gate ist AI_MAX_AI_EUR_PER_HOUR (podStartTriggers).
    process.env.AI_MAX_AI_EUR_PER_HOUR = '0.01';
    const budget = await onStudioPresence(1);
    expect(budget?.blocked).toBe('budget');
    expect(calls).toHaveLength(0);
  });

  it('Status zeigt das Warmhalten', async () => {
    await onStudioPresence(1);
    expect((fleetStatus() as { brainKeepWarm: unknown }).brainKeepWarm).toMatchObject({ members: 1, warm: true, graceMs: 900_000 });
  });
});
