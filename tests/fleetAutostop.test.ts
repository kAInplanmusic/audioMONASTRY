// @vitest-environment node
/**
 * FLEET-P1-012 · Auto-Stop der RunPod-Pods mit Snapshot (gemockte RunPod-API,
 * kein Live-RunPod).
 *
 *   letzter Nutzer geht → Karenz → Checkpoint → GET /pods → DELETE eigener Pods
 *   → Nachprüfung → fleetStatus: 0 laufende Pods, "0,00 €/h", Zähler gestoppt.
 *
 * Geprüft: Karenz + Abbruch bei Rückkehr, Snapshot-vor-Stop-Reihenfolge, nur
 * Pods mit Präfix `audiomonastry-pod-`, Idempotenz, Fehlerpfad (Retry, Alarm),
 * Dry-run, Schalter, Idle-Timer ohne Jobs, Kosten 0.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAiGate, setAiOperatingMode } from '../src/core/ai/aiGate';
import { createSessionRuntime } from '../server/sessionRuntime';
import { MemorySessionPersistence, type AuthoritativeSessionPersistence } from '../src/core/session/authoritativeSession';
import {
  POD_NAME_PREFIX,
  runFleetAutostop,
  setFleetAutostopHooks,
  type CheckpointProof,
} from '../src/core/ai/orchestrator/fleetAutostop';
import { __resetFleetWakeState, fleetStatus, onStudioPresence, sleepFleet } from '../src/core/ai/orchestrator/fleetWake';
import { POD_ROLE_IDS } from '../src/core/ai/orchestrator/podRouting';
import { setPodWakeKillSwitch } from '../src/core/ai/orchestrator/podStartTriggers';
import { RunPodProvider } from '../src/core/ai/orchestrator/runpodProvider';

const TOKEN = 't'.repeat(40);
const REST = 'https://rest.example/v1';
const KEYS = [
  'AI_FLEET_MODE', 'AI_POD_TOKEN', 'AI_MODE', 'AI_OPERATING_MODE', 'AI_FLEET_WAKE', 'AI_FLEET_SLEEP',
  'AI_MAX_AI_EUR_PER_HOUR', 'AI_POD_READY_TIMEOUT_MS', 'AI_POD_READY_POLL_MS', 'AI_BRAIN_KEEPWARM_GRACE_MS',
  'AI_FLEET_AUTOSTOP', 'AI_FLEET_AUTOSTOP_DRYRUN', 'AI_FLEET_AUTOSTOP_GRACE_MS', 'AI_FLEET_AUTOSTOP_IDLE_MS',
  'AI_FLEET_AUTOSTOP_RETRIES', 'AI_FLEET_AUTOSTOP_RETRY_MS',
  'RP_AGENT_KEY', 'RP_API_KEY', 'RUNPOD_API_KEY', 'RUNPOD_REST_BASE',
  ...POD_ROLE_IDS.flatMap((r) => [`RP_POD_ID_${r.toUpperCase()}`, `RP_POD_URL_${r.toUpperCase()}`]),
];

interface AccountPod { id: string; name: string; desiredStatus: string }
interface Call { url: string; method: string }

let calls: Call[] = [];
/** Reihenfolge der Ereignisse (checkpoint, list, delete:<name>) – Nachweis Snapshot → Stop. */
let order: string[] = [];
let account: AccountPod[] = [];
/** HTTP-Status, den DELETE liefert (Default 200). */
let deleteStatus = 200;
let alarms: Array<{ message: string; details: Record<string, unknown> }> = [];
let logs: Array<Record<string, unknown>> = [];
let errorLines: string[] = [];

function seedAccount(): void {
  account = [
    ...POD_ROLE_IDS.map((r) => ({ id: `${r}pod1`, name: `${POD_NAME_PREFIX}${r}`, desiredStatus: 'RUNNING' })),
    // Fremde Pods im selben Konto – dürfen NIE angefasst werden.
    { id: 'foreignpod9', name: 'someone-else-gpu', desiredStatus: 'RUNNING' },
    { id: 'foreignpod8', name: 'audiomonastry-test', desiredStatus: 'RUNNING' },
    // Eigener, schon terminierter Pod (wird nicht erneut gelöscht).
    { id: 'oldpod77', name: `${POD_NAME_PREFIX}old`, desiredStatus: 'TERMINATED' },
  ];
}

function mockRunPod(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url === `${REST}/pods` && method === 'GET') {
      order.push('list');
      return json(account);
    }
    const del = /\/pods\/([a-z0-9]+)$/.exec(url);
    if (del && method === 'DELETE') {
      const pod = account.find((p) => p.id === del[1]);
      order.push(`delete:${pod?.name ?? del[1]}`);
      if (deleteStatus !== 200) return json({ error: 'nope' }, deleteStatus);
      if (!pod) return json({ error: 'not found' }, 404);
      account = account.filter((p) => p.id !== del[1]);
      return new Response(null, { status: 204 });
    }
    if (/\/pods\/[a-z0-9]+\/start$/.test(url)) return json({ desiredStatus: 'RUNNING' });
    if (url.endsWith('/ready')) return json({ status: 'ready' });
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
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    errorLines.push(String(line));
    grab(line);
  });
}

function podsMode(): void {
  process.env.AI_FLEET_MODE = 'pods';
  process.env.AI_POD_TOKEN = TOKEN;
  process.env.AI_POD_READY_POLL_MS = '10';
  process.env.AI_POD_READY_TIMEOUT_MS = '2000';
  process.env.RP_API_KEY = 'rk_test_full';
  process.env.RUNPOD_REST_BASE = REST;
  process.env.AI_FLEET_AUTOSTOP_GRACE_MS = '30';
  process.env.AI_FLEET_AUTOSTOP_RETRY_MS = '1';
  for (const r of POD_ROLE_IDS) process.env[`RP_POD_ID_${r.toUpperCase()}`] = `${r}pod1`;
}

const okCheckpoint = (): Promise<CheckpointProof> => {
  order.push('checkpoint');
  return Promise.resolve({ ok: true, snapshotId: 'snap-1', revision: 7, verified: true, persistence: 'MemorySessionPersistence' });
};

function wireHooks(checkpoint: () => Promise<CheckpointProof> = okCheckpoint): void {
  setFleetAutostopHooks({
    checkpoint,
    alarm: (message, details) => { alarms.push({ message, details }); },
  });
}

const deletes = () => calls.filter((c) => c.method === 'DELETE');
const lastAutostop = () => (fleetStatus().autostop as { lastReport: Record<string, unknown> | null }).lastReport;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FLEET-P1-012: Auto-Stop mit Snapshot', () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
    __resetAiGate();
    __resetFleetWakeState();
    calls = [];
    order = [];
    alarms = [];
    logs = [];
    errorLines = [];
    deleteStatus = 200;
    seedAccount();
    mockRunPod();
    captureLogs();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const k of KEYS) delete process.env[k];
    __resetFleetWakeState();
    __resetAiGate();
  });

  it('Präfix = namePrefix aus deploy/runpod/pod-fleet.json', () => {
    const fleet = JSON.parse(readFileSync(fileURLToPath(new URL('../deploy/runpod/pod-fleet.json', import.meta.url)), 'utf8')) as { namePrefix: string };
    expect(POD_NAME_PREFIX).toBe(fleet.namePrefix);
  });

  it('letzter Nutzer geht → Karenz → Checkpoint VOR Terminate, nur eigene Pods, danach 0 Pods und 0,00 €/h', async () => {
    podsMode();
    wireHooks();
    await onStudioPresence(1);
    const before = fleetStatus().autostop as { runningPods: number; costMeter: { running: boolean } };
    expect(before.runningPods).toBe(2); // brain + ears
    expect(before.costMeter.running).toBe(true);

    onStudioPresence(0);
    expect(deletes()).toHaveLength(0); // Karenz läuft noch
    await vi.waitFor(() => expect(lastAutostop()).not.toBeNull(), { timeout: 2000 });

    const report = lastAutostop() as Record<string, unknown>;
    expect(report).toMatchObject({ reason: 'presence-grace', ok: true, aborted: null, dryRun: false, remaining: 0, alarm: false });
    expect(report.steps).toEqual(['checkpoint', 'list', 'terminate', 'verify']);
    // Reihenfolge: Checkpoint vor der ersten Liste und vor jedem DELETE.
    expect(order[0]).toBe('checkpoint');
    expect(order.indexOf('checkpoint')).toBeLessThan(order.findIndex((o) => o.startsWith('delete:')));
    // Nur eigene, aktive Pods – fremde und schon terminierte nie.
    expect((report.terminated as string[]).sort()).toEqual(POD_ROLE_IDS.map((r) => `${POD_NAME_PREFIX}${r}`).sort());
    expect(report.foreignSkipped).toBe(2);
    expect(deletes().map((c) => c.url).some((u) => /foreignpod|oldpod/.test(u))).toBe(false);
    expect(account.map((p) => p.id).sort()).toEqual(['foreignpod8', 'foreignpod9', 'oldpod77']);
    // Terminate, nicht Stop: kein POST /stop.
    expect(calls.some((c) => c.url.endsWith('/stop'))).toBe(false);

    const status = fleetStatus() as {
      autostop: { runningPods: number; costLine: string; costMeter: { running: boolean; costLine: string } };
      podStartTriggers: { budget: { activePods: number; eurPerHour: number; costLine: string } };
    };
    expect(status.autostop.runningPods).toBe(0);
    expect(status.autostop.costLine).toBe('0,00 €/h');
    expect(status.autostop.costMeter).toMatchObject({ running: false, costLine: '0,00 €/h' });
    expect(status.podStartTriggers.budget).toMatchObject({ activePods: 0, eurPerHour: 0, costLine: '0,00 €/h' });
    expect(report.costLine).toBe('0,00 €/h');
    expect(logs.some((l) => l.msg === 'pod cost meter stopped')).toBe(true);
  });

  it('Rückkehr innerhalb der Karenz bricht ab: kein Checkpoint, kein DELETE', async () => {
    podsMode();
    process.env.AI_FLEET_AUTOSTOP_GRACE_MS = '60';
    wireHooks();
    await onStudioPresence(1);
    onStudioPresence(0);
    await sleepMs(10);
    await onStudioPresence(1);
    await sleepMs(120);
    expect(order).not.toContain('checkpoint');
    expect(deletes()).toHaveLength(0);
    expect(lastAutostop()).toBeNull();
    expect(logs.some((l) => l.msg === 'brain keep-warm: rejoin within grace, sleep cancelled')).toBe(true);
  });

  it('Rückkehr während des Checkpoints bricht VOR dem Terminieren ab', async () => {
    podsMode();
    wireHooks(async () => {
      order.push('checkpoint');
      void onStudioPresence(1); // jemand kommt zurück, während der Snapshot läuft
      return { ok: true, snapshotId: 'snap-2', verified: true };
    });
    await onStudioPresence(1);
    onStudioPresence(0);
    await vi.waitFor(() => expect(lastAutostop()).not.toBeNull(), { timeout: 2000 });
    expect(lastAutostop()).toMatchObject({ aborted: 'rejoined', ok: true, steps: ['checkpoint'] });
    expect(deletes()).toHaveLength(0);
  });

  it('idempotent: parallele Aufrufe teilen den Lauf; zweiter Lauf findet nichts mehr; 404 = schon weg', async () => {
    podsMode();
    wireHooks();
    const [a, b] = [runFleetAutostop('manual'), runFleetAutostop('manual')];
    expect(a).toBe(b);
    const first = await a;
    expect(first.ok).toBe(true);
    expect(deletes()).toHaveLength(POD_ROLE_IDS.length);

    calls = [];
    const second = await runFleetAutostop('manual');
    expect(second).toMatchObject({ ok: true, terminated: [], remaining: 0, alarm: false });
    expect(deletes()).toHaveLength(0);

    // Pod verschwindet zwischen Liste und DELETE → 404 zählt als erledigt.
    seedAccount();
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE' && String(input).endsWith('/brainpod1')) {
        account = account.filter((p) => p.id !== 'brainpod1');
        return new Response('{}', { status: 404 });
      }
      return real(input, init);
    }));
    const third = await runFleetAutostop('manual');
    expect(third.ok).toBe(true);
    expect(third.alreadyGone).toEqual([`${POD_NAME_PREFIX}brain`]);
  });

  it('Fehlerpfad: DELETE 500 → Retry je Pod, laute Warnung, Alarm, Zähler läuft weiter', async () => {
    podsMode();
    process.env.AI_FLEET_AUTOSTOP_RETRIES = '3';
    wireHooks();
    await onStudioPresence(1);
    deleteStatus = 500;
    // Session ist "leer" für den manuellen Lauf (force), Presence bleibt unberührt.
    const report = await runFleetAutostop('manual', { force: true });
    expect(report.ok).toBe(false);
    expect(report.failed).toHaveLength(POD_ROLE_IDS.length);
    expect(deletes()).toHaveLength(POD_ROLE_IDS.length * 3);
    expect(report.alarm).toBe(true);
    expect(alarms).toHaveLength(1);
    expect(alarms[0].message).toMatch(/nicht beendet/);
    expect(errorLines.some((l) => l.includes('[fleet-autostop] ALARM'))).toBe(true);
    expect(logs.some((l) => l.msg === 'fleet autostop FAILED')).toBe(true);
    const status = fleetStatus().autostop as { runningPods: number; costMeter: { running: boolean } };
    expect(status.runningPods).toBe(2);
    expect(status.costMeter.running).toBe(true);
  });

  it('Pod-Liste nicht lesbar (kein Key) → Alarm, kein DELETE', async () => {
    podsMode();
    delete process.env.RP_API_KEY;
    wireHooks();
    const report = await runFleetAutostop('manual');
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/RunPod-Key fehlt/);
    expect(alarms).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
  });

  it('Checkpoint scheitert → Retry + Alarm, Pods werden trotzdem beendet (sie halten keinen Session-Zustand)', async () => {
    podsMode();
    let attempts = 0;
    wireHooks(async () => {
      attempts += 1;
      order.push('checkpoint');
      throw new Error('redis down');
    });
    const report = await runFleetAutostop('manual');
    expect(attempts).toBe(3);
    expect(report.checkpoint).toMatchObject({ ok: false, error: 'redis down' });
    expect(report.alarm).toBe(true);
    expect(alarms[0].message).toMatch(/Checkpoint/);
    expect(order.lastIndexOf('checkpoint')).toBeLessThan(order.findIndex((o) => o.startsWith('delete:')));
    expect(report.terminated).toHaveLength(POD_ROLE_IDS.length);
  });

  it('Dry-run: Checkpoint + Liste, aber kein DELETE; Zustand und Kosten unverändert', async () => {
    podsMode();
    process.env.AI_FLEET_AUTOSTOP_DRYRUN = '1';
    wireHooks();
    await onStudioPresence(1);
    onStudioPresence(0);
    await vi.waitFor(() => expect(lastAutostop()).not.toBeNull(), { timeout: 2000 });
    expect(lastAutostop()).toMatchObject({ dryRun: true, ok: true, steps: ['checkpoint', 'list'] });
    expect(((lastAutostop() as { wouldTerminate: string[] }).wouldTerminate)).toHaveLength(POD_ROLE_IDS.length);
    expect(deletes()).toHaveLength(0);
    expect((fleetStatus().autostop as { runningPods: number }).runningPods).toBe(2);
  });

  it('AI_FLEET_AUTOSTOP=0: kein REST-Aufruf nach der Karenz; sleepFleet meldet den Grund', async () => {
    podsMode();
    process.env.AI_FLEET_AUTOSTOP = '0';
    process.env.AI_BRAIN_KEEPWARM_GRACE_MS = '20';
    wireHooks();
    await onStudioPresence(1);
    onStudioPresence(0);
    await sleepMs(80);
    expect(deletes()).toHaveLength(0);
    expect(calls.some((c) => c.url === `${REST}/pods`)).toBe(false);
    const sleep = await sleepFleet();
    expect(sleep.roles[0].error).toMatch(/AI_FLEET_AUTOSTOP=0/);
  });

  it('Kill-Switch und AI aus sperren nur das Starten – Stoppen läuft', async () => {
    podsMode();
    wireHooks();
    setPodWakeKillSwitch(() => true);
    setAiOperatingMode('off');
    const report = await runFleetAutostop('manual');
    expect(report.ok).toBe(true);
    expect(report.terminated).toHaveLength(POD_ROLE_IDS.length);
  });

  it('Idle-Timer: Pods durch Auftrag gestartet, niemand im Studio → nach dem Idle-Fenster beendet', async () => {
    podsMode();
    process.env.AI_FLEET_AUTOSTOP_IDLE_MS = '40';
    wireHooks();
    await new RunPodProvider('voiceGen').run('tts', 'qwen3-tts-17b', { text: 'hallo' });
    expect(deletes()).toHaveLength(0);
    await vi.waitFor(() => expect(lastAutostop()).not.toBeNull(), { timeout: 3000 });
    expect(lastAutostop()).toMatchObject({ reason: 'idle-no-jobs', ok: true });
    expect(order[0]).toBe('checkpoint');
    expect((fleetStatus().autostop as { costLine: string }).costLine).toBe('0,00 €/h');
  });

  it('Idle-Timer feuert nicht, solange jemand im Studio ist', async () => {
    podsMode();
    process.env.AI_FLEET_AUTOSTOP_IDLE_MS = '20';
    wireHooks();
    await onStudioPresence(1);
    await new RunPodProvider('voiceGen').run('tts', 'qwen3-tts-17b', { text: 'hallo' });
    await sleepMs(100);
    expect(deletes()).toHaveLength(0);
    expect(lastAutostop()).toBeNull();
  });

  it('sleepFleet im Pod-Modus läuft über den Auto-Stop (bei leerer Session)', async () => {
    podsMode();
    wireHooks();
    const report = await sleepFleet();
    expect(report.autostop).toMatchObject({ reason: 'sleep-fleet', ok: true });
    expect(deletes()).toHaveLength(POD_ROLE_IDS.length);
  });

  it('Serverless-Modus: Auto-Stop tut nichts', async () => {
    wireHooks();
    process.env.RP_API_KEY = 'rk';
    process.env.RUNPOD_REST_BASE = REST;
    const report = await runFleetAutostop('manual');
    expect(report.aborted).toBe('serverless');
    expect(calls).toHaveLength(0);
  });
});

describe('FLEET-P1-012: sessionRuntime.checkpoint() – Nachweis vor dem Stop', () => {
  it('schreibt Persistenz + Snapshot und liest ihn geprüft zurück (inkl. Studio-Store)', async () => {
    const runtime = createSessionRuntime({ log: () => {} });
    const persistence = new MemorySessionPersistence();
    runtime.setPersistence(persistence);
    expect(runtime.session.storeSet('mixer.settings', '{"gain":3}', 'u1').ok).toBe(true);
    const proof = await runtime.checkpoint();
    expect(proof).toMatchObject({ ok: true, verified: true, persistence: 'MemorySessionPersistence', studioStoreKeys: 1 });
    const saved = await persistence.load();
    expect(saved?.revision).toBe(proof.revision);
    expect(saved?.studioStore?.[0]?.[0]).toBe('mixer.settings');
    const latest = await runtime.getSnapshotStore().restore('latest');
    expect(latest?.id).toBe(proof.snapshotId);
    expect(latest?.checksum).toBe(proof.checksum);
    runtime.stop();
  });

  it('wirft, wenn die Persistenz nicht schreiben kann (Aufrufer alarmiert)', async () => {
    const runtime = createSessionRuntime({ log: () => {} });
    const broken: AuthoritativeSessionPersistence = {
      load: async () => null,
      save: async () => { throw new Error('disk full'); },
    };
    runtime.setPersistence(broken);
    await expect(runtime.checkpoint()).rejects.toThrow('disk full');
    runtime.stop();
  });
});
