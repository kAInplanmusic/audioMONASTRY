// @vitest-environment node
/**
 * FLEET-P1-012 · Auto-Stop der Vast.ai-Pods mit Snapshot (gemockte Vast-API,
 * kein Live-Vast).
 *
 *   letzter Nutzer geht → Karenz → Checkpoint → GET console.vast.ai/api/v1/instances
 *   → DELETE /api/v0/instances/<id>/ je eigener Instanz (Label `audiomonastry-vast-`)
 *   → Nachprüfung → fleetStatus: 0 laufende Instanzen, "0,00 €/h", Zähler gestoppt.
 *
 * Geprüft: Karenz + Abbruch bei Rückkehr, Snapshot-vor-Stop-Reihenfolge, nur
 * Pods mit Präfix `audiomonastry-pod-`, Idempotenz, Fehlerpfad (Retry, Alarm),
 * Dry-run, Schalter, Idle-Timer ohne Jobs, Kosten 0.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { setPodWakeKillSwitch, __resetPodStartTriggers } from '../src/core/ai/orchestrator/podStartTriggers';
import { VastProvider } from '../src/core/ai/orchestrator/vastProvider';

const TOKEN = 't'.repeat(40);
const VAST_LIST = 'https://console.vast.ai/api/v1/instances';
const VAST_INSTANCE = 'https://console.vast.ai/api/v0/instances/';
/** Instanz-ID je Rolle (Vast vergibt numerische IDs). */
const podId = (role: string) => String(10000 + POD_ROLE_IDS.indexOf(role as (typeof POD_ROLE_IDS)[number]));
const KEYS = [
  'AI_FLEET_MODE', 'AI_POD_TOKEN', 'AI_MODE', 'AI_OPERATING_MODE', 'AI_FLEET_WAKE', 'AI_FLEET_SLEEP',
  'AI_MAX_AI_EUR_PER_HOUR', 'AI_POD_READY_TIMEOUT_MS', 'AI_POD_READY_POLL_MS', 'AI_BRAIN_KEEPWARM_GRACE_MS',
  'AI_FLEET_AUTOSTOP', 'AI_FLEET_AUTOSTOP_DRYRUN', 'AI_FLEET_AUTOSTOP_GRACE_MS', 'AI_FLEET_AUTOSTOP_IDLE_MS',
  'AI_FLEET_AUTOSTOP_RETRIES', 'AI_FLEET_AUTOSTOP_RETRY_MS',
  'VAST_API_KEY',
  ...POD_ROLE_IDS.flatMap((r) => ['ID', 'URL', 'EUR_PER_HOUR'].map((k) => `VAST_POD_${k}_${r.toUpperCase().replace(/-/g, "_")}`)),
];

/** Vast-Instanz, wie GET /api/v1/instances sie liefert. */
interface AccountPod { id: number; label: string; actual_status: string }
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
    ...POD_ROLE_IDS.map((r) => ({ id: Number(podId(r)), label: `audiomonastry-vast-${r}`, actual_status: 'running' })),
    // Fremde Instanzen im selben Konto – dürfen NIE angefasst werden.
    { id: 99999, label: 'someone-else-gpu', actual_status: 'running' },
    { id: 99998, label: 'audiomonastry-test', actual_status: 'running' },
  ];
}

function mockVast(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.startsWith(VAST_LIST) && method === 'GET') {
      order.push('list');
      return json({ instances: account });
    }
    const instance = /\/api\/v0\/instances\/(\d+)\/$/.exec(url);
    if (instance && method === 'DELETE') {
      const pod = account.find((p) => String(p.id) === instance[1]);
      order.push(`delete:${pod ? `${POD_NAME_PREFIX}${pod.label.slice('audiomonastry-vast-'.length)}` : instance[1]}`);
      if (deleteStatus !== 200) return json({ error: 'nope' }, deleteStatus);
      if (!pod) return json({ error: 'not found' }, 404);
      account = account.filter((p) => String(p.id) !== instance[1]);
      return json({ success: true });
    }
    if (instance && method === 'PUT') return json({ success: true });
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
  process.env.AI_GPU_PROVIDER = 'vast';
  process.env.AI_POD_TOKEN = TOKEN;
  process.env.AI_POD_READY_POLL_MS = '10';
  process.env.AI_POD_READY_TIMEOUT_MS = '2000';
  process.env.VAST_API_KEY = 'vk_test_full';
  process.env.AI_FLEET_AUTOSTOP_GRACE_MS = '30';
  process.env.AI_FLEET_AUTOSTOP_RETRY_MS = '1';
  for (const r of POD_ROLE_IDS) {
    const key = r.toUpperCase().replace(/-/g, "_");
    process.env[`VAST_POD_ID_${key}`] = podId(r);
    process.env[`VAST_POD_URL_${key}`] = `https://${r.replace(/-/g, '')}.pods.example`;
    process.env[`VAST_POD_EUR_PER_HOUR_${key}`] = '0.4';
  }
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
  process.env.AI_GPU_PROVIDER = 'vast';
    for (const k of KEYS) delete process.env[k];
    __resetAiGate();
    __resetFleetWakeState();
    __resetPodStartTriggers();
    calls = [];
    order = [];
    alarms = [];
    logs = [];
    errorLines = [];
    deleteStatus = 200;
    seedAccount();
    mockVast();
    captureLogs();
  });
  afterEach(() => {
  delete process.env.AI_GPU_PROVIDER;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const k of KEYS) delete process.env[k];
    __resetFleetWakeState();
    __resetAiGate();
  });

  it('Präfix = namePrefix aus deploy/gpu/pod-fleet.json', () => {
    const fleet = JSON.parse(readFileSync(fileURLToPath(new URL('../deploy/gpu/pod-fleet.json', import.meta.url)), 'utf8')) as { namePrefix: string };
    expect(POD_NAME_PREFIX).toBe(fleet.namePrefix);
  });

  it('letzter Nutzer geht → Karenz → Checkpoint VOR Terminate, nur eigene Pods, danach 0 Pods und 0,00 €/h', async () => {
    podsMode();
    wireHooks();
    await onStudioPresence(1);
    const before = fleetStatus().autostop as { runningPods: number; costMeter: { running: boolean } };
    expect(before.runningPods).toBe(POD_ROLE_IDS.length);
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
    // Nur eigene Instanzen – fremde nie.
    expect((report.terminated as string[]).sort()).toEqual(POD_ROLE_IDS.map((r) => `${POD_NAME_PREFIX}${r}`).sort());
    expect(report.foreignSkipped).toBe(2);
    expect(deletes().map((c) => c.url).some((u) => /\/(99998|99999)\/$/.test(u))).toBe(false);
    expect(deletes().every((c) => c.url.startsWith(VAST_INSTANCE))).toBe(true);
    expect(account.map((p) => p.id).sort()).toEqual([99998, 99999]);
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
      if ((init?.method ?? 'GET') === 'DELETE' && String(input) === `${VAST_INSTANCE}${podId('brain')}/`) {
        account = account.filter((p) => String(p.id) !== podId('brain'));
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
    expect(status.runningPods).toBe(POD_ROLE_IDS.length);
    expect(status.costMeter.running).toBe(true);
  });

  it('Pod-Liste nicht lesbar (kein Key) → Alarm, kein DELETE', async () => {
    podsMode();
    delete process.env.VAST_API_KEY;
    wireHooks();
    const report = await runFleetAutostop('manual');
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/VAST_API_KEY missing/);
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
    expect((fleetStatus().autostop as { runningPods: number }).runningPods).toBe(POD_ROLE_IDS.length);
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
    expect(calls.some((c) => c.url.startsWith(VAST_LIST))).toBe(false);
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
    await new VastProvider('voiceGen').run('tts', 'qwen3-tts-17b', { text: 'hallo' });
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
    await new VastProvider('voiceGen').run('tts', 'qwen3-tts-17b', { text: 'hallo' });
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
});

describe('FLEET-P1-012: Hetzner lifecycle.sh stop --dry-run (INFRA-HETZNER-022-Pfad)', () => {
  it('zeigt Snapshot → Retention → Löschen, ohne einen einzigen API-/SSH-Aufruf', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifecycle-dry-'));
    const log = join(dir, 'calls.log');
    // Stubs: jeder Aufruf von curl/ssh würde protokolliert.
    for (const tool of ['curl', 'ssh']) {
      const stub = join(dir, tool);
      writeFileSync(stub, `#!/usr/bin/env bash\necho "${tool} $*" >> "${log}"\n`);
      chmodSync(stub, 0o755);
    }
    const script = fileURLToPath(new URL('../scripts/hetzner/lifecycle.sh', import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, LIFECYCLE_ENV_FILE: join(dir, 'missing.env') };
    delete env.HCLOUD_TOKEN;
    const run = spawnSync('bash', [script, 'stop', '--dry-run'], { env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    const out = run.stdout;
    expect(out).toContain('DRY-RUN lifecycle.sh stop');
    expect(out).toMatch(/audiomonastry-app-1: würde Snapshot 'audiomonastry-app-1-auto-/);
    expect(out.indexOf('würde Snapshot')).toBeLessThan(out.indexOf('delete-fleet.sh --yes'));
    expect(out).toContain('Ausgeführt wurde nichts');
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');
    rmSync(dir, { recursive: true, force: true });
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
