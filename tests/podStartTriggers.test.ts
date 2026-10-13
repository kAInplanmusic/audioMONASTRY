// @vitest-environment node
/**
 * FLEET-P1-001 · Start-Trigger je Pod (gemockte Flotte, kein Live-RunPod).
 *
 *   always        RP1 brain + RP2 ears   beim Session-Start
 *   aiGeneration  RP3 music + RP4 voice  bei der ersten AI-Generierung
 *   stemMONK      RP5 stems              beim Start des stemMONK
 *
 * Nachweis über Netzwerkaufrufe (welcher Pod wird angefragt) und Logzeilen
 * (`fleet pod ...`); Sperren: AI-Schalter, Kill-Switch, AI_MAX_AI_EUR_PER_HOUR.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';
import {
  __resetFleetWakeState,
  fleetStatus,
  onPluginActivity,
  onStudioPresence,
} from '../src/core/ai/orchestrator/fleetWake';
import { ACE_STEP_BASE_MODEL } from '../src/core/ai/orchestrator/musicContextTools';
import { LEGO_BASE_MODEL, POD_ROLE_IDS, POD_START_TRIGGERS, podsForTrigger } from '../src/core/ai/orchestrator/podRouting';
import { setPodWakeKillSwitch, triggerPodStart } from '../src/core/ai/orchestrator/podStartTriggers';
import { RunPodProvider } from '../src/core/ai/orchestrator/runpodProvider';

const TOKEN = 't'.repeat(40);
const KEYS = [
  'AI_FLEET_MODE', 'AI_POD_TOKEN', 'AI_MODE', 'AI_OPERATING_MODE', 'AI_FLEET_WAKE', 'AI_FLEET_SLEEP',
  'AI_MAX_AI_EUR_PER_HOUR', 'AI_POD_READY_TIMEOUT_MS', 'AI_POD_READY_POLL_MS',
  'RP_AGENT_KEY', 'RP_API_KEY', 'RUNPOD_API_KEY', 'RUNPOD_REST_BASE',
  ...POD_ROLE_IDS.flatMap((r) => [`RP_POD_ID_${r.toUpperCase()}`, `RP_POD_URL_${r.toUpperCase()}`]),
];

interface Fleet { pods: Array<{ role: string; startTrigger: string }> }
const fleet = JSON.parse(readFileSync(fileURLToPath(new URL('../deploy/runpod/pod-fleet.json', import.meta.url)), 'utf8')) as Fleet;

interface Call { url: string; method: string }
let calls: Call[] = [];
let logs: Array<Record<string, unknown>> = [];
/** Pods, deren /ready (noch) 503 liefert. */
let down = new Set<string>();

function podOf(url: string): string {
  return /^https:\/\/([a-z]+)pod1-8000/.exec(url)?.[1] ?? '';
}

function mockFleet(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const restStart = /\/pods\/([a-z]+)pod1\/start$/.exec(url);
    if (restStart) {
      down.delete(restStart[1]);
      return json({ id: `${restStart[1]}pod1`, desiredStatus: 'RUNNING' });
    }
    if (url.endsWith('/ready')) return down.has(podOf(url)) ? json({ ready: false }, 503) : json({ status: 'ready' });
    if (url.endsWith('/runsync')) return json({ id: 'j1', status: 'COMPLETED', output: { status: 'success', result: { ok: 1 } } });
    if (url.endsWith('/run')) return json({ id: 'j2', status: 'IN_QUEUE' });
    return json({ id: 'j2', status: 'COMPLETED', output: { status: 'success', result: { ok: 2 } } });
  }));
}

function captureLogs(): void {
  const grab = (line: unknown) => {
    try { logs.push(JSON.parse(String(line)) as Record<string, unknown>); } catch { /* fremde Zeile */ }
  };
  vi.spyOn(console, 'log').mockImplementation(grab);
  vi.spyOn(console, 'warn').mockImplementation(grab);
  vi.spyOn(console, 'error').mockImplementation(grab);
}

const readyPods = () => [...new Set(calls.filter((c) => c.url.endsWith('/ready')).map((c) => podOf(c.url)))].sort();
const podLog = (msg: string) => logs.filter((l) => l.msg === msg);

function podsMode(): void {
  process.env.AI_FLEET_MODE = 'pods';
  process.env.AI_POD_TOKEN = TOKEN;
  process.env.AI_POD_READY_POLL_MS = '10';
  process.env.AI_POD_READY_TIMEOUT_MS = '2000';
  for (const r of POD_ROLE_IDS) process.env[`RP_POD_ID_${r.toUpperCase()}`] = `${r}pod1`;
}

describe('FLEET-P1-001: Start-Trigger je Pod', () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
    __resetAiGate();
    __resetFleetWakeState();
    calls = [];
    logs = [];
    down = new Set();
    mockFleet();
    captureLogs();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const k of KEYS) delete process.env[k];
    __resetFleetWakeState();
    __resetAiGate();
  });

  it('Code-Tabelle = startTrigger in pod-fleet.json; LEGO-Modell = ACE_STEP_BASE_MODEL', () => {
    for (const pod of fleet.pods) {
      expect(POD_START_TRIGGERS[pod.role as keyof typeof POD_START_TRIGGERS], pod.role).toBe(pod.startTrigger);
    }
    expect(Object.keys(POD_START_TRIGGERS).sort()).toEqual(fleet.pods.map((p) => p.role).sort());
    expect(podsForTrigger('always')).toEqual(['brain', 'ears']);
    expect(podsForTrigger('aiGeneration').sort()).toEqual(['music', 'voice']);
    expect(podsForTrigger('stemMONK')).toEqual(['stems']);
    expect(LEGO_BASE_MODEL).toBe(ACE_STEP_BASE_MODEL);
  });

  it('Session-Start weckt nur RP1 brain + RP2 ears (Log + fleetStatus)', async () => {
    podsMode();
    const report = await onStudioPresence(1);
    expect(report?.blocked).toBeNull();
    expect(readyPods()).toEqual(['brain', 'ears']);
    expect(podLog('fleet pod ready').map((l) => l.pod).sort()).toEqual(['brain', 'ears']);
    expect(podLog('fleet pod trigger')[0]).toMatchObject({ trigger: 'always', reason: 'session-start' });

    const status = fleetStatus().podStartTriggers as { pods: Array<{ pod: string; state: string; startTrigger: string }> };
    expect(status.pods.filter((p) => p.state === 'ready').map((p) => p.pod).sort()).toEqual(['brain', 'ears']);
    expect(status.pods.find((p) => p.pod === 'stems')).toMatchObject({ state: 'off', startTrigger: 'stemMONK' });

    // weitere Joins wecken nichts mehr
    calls = [];
    expect(onStudioPresence(2)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('erste AI-Generierung (tts) weckt RP3 music + RP4 voice, nicht stems; zweite Generierung ohne neuen Weckruf', async () => {
    podsMode();
    await onStudioPresence(1);
    calls = [];
    await new RunPodProvider('voiceGen').run('tts', 'qwen3-tts-17b', { text: 'hallo' });
    await vi.waitFor(() => expect(readyPods()).toEqual(['music', 'voice']));
    expect(podLog('fleet pod trigger').some((l) => l.trigger === 'aiGeneration' && String(l.reason).includes('first ai generation (tts)'))).toBe(true);
    expect(calls.some((c) => c.url.includes('stemspod1'))).toBe(false);

    calls = [];
    await new RunPodProvider('music').run('song', 'acestep-v15-xl-sft', { prompt: 'x' });
    expect(calls.filter((c) => c.url.endsWith('/ready'))).toHaveLength(0);
    expect(calls[0].url).toBe('https://musicpod1-8000.proxy.runpod.net/run');
  });

  it('stemMONK gestartet weckt RP5 stems; andere Plugins nicht', async () => {
    podsMode();
    expect(onPluginActivity('eq')).toBeNull();
    expect(onPluginActivity('mixer')).toBeNull();
    const report = await onPluginActivity('stem');
    expect(report?.trigger).toBe('stemMONK');
    expect(readyPods()).toEqual(['stems']);
    expect(podLog('fleet pod trigger: plugin started')[0]).toMatchObject({ canonical: 'stem' });
    // bereit → kein zweiter Weckruf
    expect(onPluginActivity('stem')).toBeNull();
  });

  it('gestoppter Pod: /ready 503 → RunPod-REST start → /ready ok (startRequested)', async () => {
    podsMode();
    process.env.RP_AGENT_KEY = 'rk_test';
    process.env.RUNPOD_REST_BASE = 'https://rest.example/v1';
    down = new Set(['stems']);
    const report = await onPluginActivity('stem');
    expect(report?.pods[0]).toMatchObject({ pod: 'stems', state: 'ready', startRequested: true });
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('https://rest.example/v1/pods/stemspod1/start');
    expect(podLog('fleet pod start requested')[0]).toMatchObject({ pod: 'stems', requested: true });
  });

  it('nie bereit → failed mit Grund, kein Wurf; ohne Key kein REST-Aufruf', async () => {
    podsMode();
    process.env.AI_POD_READY_TIMEOUT_MS = '50';
    down = new Set(['stems']);
    const report = await triggerPodStart('stemMONK', 'test');
    expect(report.pods[0]).toMatchObject({ pod: 'stems', state: 'failed', startRequested: false });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(podLog('fleet pod not ready')).toHaveLength(1);
  });

  it('AI-Schalter aus: kein Netzwerkaufruf, Zustand blocked', async () => {
    podsMode();
    setAiOperatingMode('off');
    const report = await onStudioPresence(1);
    expect(report?.blocked).toBe('ai-off');
    expect(calls).toHaveLength(0);
    expect(podLog('fleet pod wake blocked')[0]).toMatchObject({ block: 'ai-off' });
    const status = fleetStatus().podStartTriggers as { pods: Array<{ pod: string; state: string }> };
    expect(status.pods.find((p) => p.pod === 'brain')?.state).toBe('blocked');
  });

  it('Kill-Switch: kein Netzwerkaufruf', async () => {
    podsMode();
    setPodWakeKillSwitch(() => true);
    const report = await triggerPodStart('always', 'session-start');
    expect(report.blocked).toBe('kill-switch');
    expect(calls).toHaveLength(0);
  });

  it('Budget AI_MAX_AI_EUR_PER_HOUR: zwei Pods passen, Generierung (4 Pods) wird gesperrt, Job scheitert klar', async () => {
    podsMode();
    process.env.AI_MAX_AI_EUR_PER_HOUR = '1'; // 2 × 0,49 $ × 0,92 = 0,90 €/h ok, 4 Pods = 1,80 €/h nicht
    await onStudioPresence(1);
    expect(readyPods()).toEqual(['brain', 'ears']);
    calls = [];
    await expect(new RunPodProvider('voiceGen').run('tts', 'qwen3-tts-17b', { text: 'x' }))
      .rejects.toMatchObject({ code: 'POD_WAKE_BUDGET' });
    expect(calls).toHaveLength(0);
    expect(podLog('fleet pod wake blocked').some((l) => l.block === 'budget')).toBe(true);
    const status = fleetStatus().podStartTriggers as { budget: { activePods: number; maxEurPerHour: number } };
    expect(status.budget).toMatchObject({ activePods: 2, maxEurPerHour: 1 });
  });

  it('Serverless-Modus: Trigger tut nichts (Endpoints skalieren selbst)', async () => {
    const report = await triggerPodStart('aiGeneration', 'test');
    expect(report.mode).toBe('serverless');
    expect(calls).toHaveLength(0);
  });
});
