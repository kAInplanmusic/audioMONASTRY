/**
 * audioMONASTRY · Start-Trigger der 5 RunPod-Pods (FLEET-P1-001)
 * ===============================================================
 * Betreiber 2026-10-12 (docs/AI_FLEET_STARTPLAN.md, `startTrigger` in
 * deploy/runpod/pod-fleet.json):
 *
 *   always        RP1 brain + RP2 ears   beim Session-Start (erster Nutzer)
 *   aiGeneration  RP3 music + RP4 voice  beim ersten Generierungs-Auftrag
 *                                        (music.* / voice.* / song / sing / tts / sfx)
 *   stemMONK      RP5 stems              wenn der stemMONK gestartet wird
 *                                        (Plugin-Modus nicht OFF) oder ein
 *                                        stem.separate-Auftrag kommt
 *
 * Gilt nur im Pod-Modus (`AI_FLEET_MODE=pods`). Serverless skaliert selbst.
 *
 * „Wecken“ eines Pods (lazy, je Pod genau ein laufender Versuch):
 *   1. `GET <pod>/ready` – läuft er schon, ist er sofort bereit (kein Start).
 *   2. Sonst, wenn `RP_POD_ID_<POD>` und ein RunPod-Key gesetzt sind:
 *      `POST <RUNPOD_REST_BASE>/pods/<id>/start` (gestoppten Pod fortsetzen).
 *      Neu anlegen kann nur `scripts/runpod-pods.py up` (Image, Gewichte).
 *   3. `/ready` pollen bis `AI_POD_READY_TIMEOUT_MS` (Default 600 000).
 *
 * Sperren VOR jedem Netzwerkaufruf (wie fleetWake):
 *   - AI_FLEET_WAKE=0       → nichts passiert
 *   - AI-Schalter aus       → blockiert (`ai-off`), auch je Rolle (isRoleAllowed)
 *   - Kill-Switch           → blockiert (`kill-switch`, vom Server injiziert)
 *   - Budget                → laufende + neue Pods × A40-Pod-Preis
 *                             ≤ AI_MAX_AI_EUR_PER_HOUR (Default 4 €/h)
 *
 * Jede Zustandsänderung schreibt eine `fleet pod ...`-Logzeile (Nachweis).
 */
import { envNumber, RUNPOD_48GB_USD_PER_HOUR, type GpuRoleId } from '../../../config/aiInfrastructure';
import { isAiDisabled, isRoleAllowed } from '../aiGate';
import { aiLogger } from './aiLogger';
import {
  fleetMode,
  isAiGenerationTask,
  podBaseUrl,
  podsForTrigger,
  podToken,
  POD_ROLE_IDS,
  POD_START_TRIGGERS,
  type PodRoleId,
  type PodStartTrigger,
} from './podRouting';
import type { AiTask } from './types';

export type PodWakeState = 'off' | 'starting' | 'ready' | 'failed' | 'blocked';
export type PodWakeBlock = 'ai-off' | 'kill-switch' | 'budget' | 'disabled';

/** GPU-Rollen, die ein Pod abdeckt (für den AI-Schalter je Rolle). */
const POD_GPU_ROLES: Readonly<Record<PodRoleId, readonly GpuRoleId[]>> = {
  brain: ['brain', 'orchestrator'],
  ears: ['ears'],
  voice: ['voiceGen'],
  stems: ['voiceGen'],
  music: ['music'],
};

interface PodRuntime {
  state: PodWakeState;
  /** Anlass des letzten Weckversuchs (Trigger + Grund). */
  trigger: PodStartTrigger | null;
  reason: string | null;
  since: number | null;
  readyAt: number | null;
  /** Wurde der Pod über die RunPod-REST-API gestartet (nicht nur bereit gefunden)? */
  startRequested: boolean;
  block: PodWakeBlock | null;
  error: string | null;
  inflight: Promise<PodWakeResult> | null;
}

export interface PodWakeResult {
  pod: PodRoleId;
  state: PodWakeState;
  block: PodWakeBlock | null;
  startRequested: boolean;
  message?: string;
}

export interface PodTriggerReport {
  trigger: PodStartTrigger;
  reason: string;
  mode: 'pods' | 'serverless';
  /** Gesetzt, wenn der ganze Lauf gesperrt war (kein Netzwerkaufruf). */
  blocked: PodWakeBlock | null;
  message?: string;
  pods: PodWakeResult[];
}

function freshRuntime(): PodRuntime {
  return { state: 'off', trigger: null, reason: null, since: null, readyAt: null, startRequested: false, block: null, error: null, inflight: null };
}

let runtimes = new Map<PodRoleId, PodRuntime>(POD_ROLE_IDS.map((pod) => [pod, freshRuntime()]));
let killSwitchGuard: () => boolean = () => false;
let lastReports: PodTriggerReport[] = [];

function rt(pod: PodRoleId): PodRuntime {
  let r = runtimes.get(pod);
  if (!r) {
    r = freshRuntime();
    runtimes.set(pod, r);
  }
  return r;
}

function env(name: string): string {
  if (typeof process === 'undefined' || !process.env) return '';
  return (process.env[name] ?? '').trim();
}

function wakeEnabled(): boolean {
  const raw = env('AI_FLEET_WAKE').toLowerCase();
  return !raw || !['0', 'false', 'no', 'off'].includes(raw);
}

function restBase(): string {
  return (env('RUNPOD_REST_BASE') || 'https://rest.runpod.io/v1').replace(/\/+$/, '');
}

function apiKey(): string {
  return env('RP_AGENT_KEY') || env('RP_API_KEY') || env('RUNPOD_API_KEY');
}

function podId(pod: PodRoleId): string {
  const id = env(`RP_POD_ID_${pod.toUpperCase()}`);
  return /^[a-z0-9]{6,40}$/i.test(id) ? id : '';
}

function readyTimeoutMs(): number {
  return Math.max(0, envNumber('AI_POD_READY_TIMEOUT_MS', 600_000));
}

function readyPollMs(): number {
  return Math.max(10, envNumber('AI_POD_READY_POLL_MS', 5_000));
}

/** Server-Hook: Kill-Switch (server/killSwitch.ts) sperrt auch das Pod-Wecken. */
export function setPodWakeKillSwitch(guard: () => boolean): void {
  killSwitchGuard = guard;
}

/** Laufende AI-Kosten der Pods in EUR/h (A40-Pod-Preis × Anzahl). */
export function podFleetEurPerHour(count: number): number {
  return count * RUNPOD_48GB_USD_PER_HOUR.pod.A40 * envNumber('AI_USD_TO_EUR', 0.92);
}

/** AI-Budget (zusätzlich zur Hetzner-Basis), zur Laufzeit gelesen. */
export function podFleetMaxEurPerHour(): number {
  return envNumber('AI_MAX_AI_EUR_PER_HOUR', 4);
}

function activePods(): PodRoleId[] {
  return POD_ROLE_IDS.filter((pod) => rt(pod).state === 'ready' || rt(pod).state === 'starting');
}

function podAllowed(pod: PodRoleId): boolean {
  return POD_GPU_ROLES[pod].some((role) => isRoleAllowed(role));
}

async function probeReady(pod: PodRoleId, signal?: AbortSignal): Promise<{ ok: boolean; message?: string }> {
  const base = podBaseUrl(pod);
  if (!base) return { ok: false, message: `Pod-Adresse fehlt (RP_POD_ID_${pod.toUpperCase()})` };
  try {
    const resp = await fetch(`${base}/ready`, {
      headers: { Authorization: `Bearer ${podToken()}` },
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    return resp.ok ? { ok: true } : { ok: false, message: `/ready HTTP ${resp.status}` };
  } catch (error) {
    return { ok: false, message: `/ready nicht erreichbar: ${(error as Error).message}` };
  }
}

async function requestStart(pod: PodRoleId, signal?: AbortSignal): Promise<{ requested: boolean; message?: string }> {
  const id = podId(pod);
  if (!id || !apiKey()) {
    return { requested: false, message: 'kein RunPod-Start möglich (RP_POD_ID_<POD> + RP_AGENT_KEY nötig; anlegen: runpod-pods.py up)' };
  }
  try {
    const resp = await fetch(`${restBase()}/pods/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return { requested: false, message: `RunPod-Start HTTP ${resp.status}` };
    return { requested: true };
  } catch (error) {
    return { requested: false, message: `RunPod-Start fehlgeschlagen: ${(error as Error).message}` };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function doWakePod(pod: PodRoleId, trigger: PodStartTrigger, reason: string, signal?: AbortSignal): Promise<PodWakeResult> {
  const r = rt(pod);
  const first = await probeReady(pod, signal);
  if (first.ok) {
    Object.assign(r, { state: 'ready', readyAt: Date.now(), error: null, block: null });
    aiLogger.info('fleet pod ready', { pod, trigger, reason, startRequested: false });
    return { pod, state: 'ready', block: null, startRequested: false };
  }
  if (!podBaseUrl(pod)) {
    Object.assign(r, { state: 'failed', error: first.message ?? 'Pod-Adresse fehlt' });
    aiLogger.warn('fleet pod not configured', { pod, trigger, reason, error: r.error });
    return { pod, state: 'failed', block: null, startRequested: false, message: r.error ?? undefined };
  }

  const start = await requestStart(pod, signal);
  r.startRequested = start.requested;
  aiLogger.info('fleet pod start requested', { pod, trigger, reason, requested: start.requested, message: start.message });

  const deadline = Date.now() + readyTimeoutMs();
  let last = first;
  while (Date.now() < deadline && !signal?.aborted) {
    await sleep(Math.min(readyPollMs(), Math.max(0, deadline - Date.now())), signal);
    last = await probeReady(pod, signal);
    if (last.ok) {
      Object.assign(r, { state: 'ready', readyAt: Date.now(), error: null, block: null });
      aiLogger.info('fleet pod ready', { pod, trigger, reason, startRequested: start.requested });
      return { pod, state: 'ready', block: null, startRequested: start.requested };
    }
  }
  const message = signal?.aborted ? 'Warten abgebrochen' : `nicht bereit nach ${readyTimeoutMs()} ms (${last.message ?? 'unbekannt'})`;
  Object.assign(r, { state: 'failed', error: message });
  aiLogger.warn('fleet pod not ready', { pod, trigger, reason, error: message, startRequested: start.requested });
  return { pod, state: 'failed', block: null, startRequested: start.requested, message };
}

/** Weckt EINEN Pod (Dedup: ein laufender Versuch je Pod; bereit = sofort zurück). */
function wakePod(pod: PodRoleId, trigger: PodStartTrigger, reason: string, signal?: AbortSignal): Promise<PodWakeResult> {
  const r = rt(pod);
  if (r.state === 'ready') return Promise.resolve({ pod, state: 'ready', block: null, startRequested: r.startRequested });
  if (r.inflight) return r.inflight;
  Object.assign(r, { state: 'starting', trigger, reason, since: Date.now(), block: null, error: null });
  const run = doWakePod(pod, trigger, reason, signal)
    .catch((error: unknown): PodWakeResult => {
      Object.assign(r, { state: 'failed', error: (error as Error).message });
      return { pod, state: 'failed', block: null, startRequested: false, message: (error as Error).message };
    })
    .finally(() => {
      r.inflight = null;
    });
  r.inflight = run;
  return run;
}

function blockAll(pods: readonly PodRoleId[], block: PodWakeBlock, message: string, trigger: PodStartTrigger, reason: string): PodTriggerReport {
  for (const pod of pods) {
    const r = rt(pod);
    if (r.state !== 'ready') Object.assign(r, { state: 'blocked', block, error: message, trigger, reason });
  }
  const report: PodTriggerReport = {
    trigger,
    reason,
    mode: 'pods',
    blocked: block,
    message,
    pods: pods.map((pod) => ({ pod, state: rt(pod).state, block, startRequested: false, message })),
  };
  aiLogger.warn('fleet pod wake blocked', { trigger, reason, pods, block, message });
  return report;
}

function remember(report: PodTriggerReport): PodTriggerReport {
  lastReports = [report, ...lastReports].slice(0, 10);
  return report;
}

/**
 * Löst einen Start-Trigger aus und wartet, bis die betroffenen Pods bereit
 * (oder gescheitert/gesperrt) sind. `only` begrenzt auf einen Pod (Lazy-Wake
 * aus einem Job heraus).
 */
export async function triggerPodStart(
  trigger: PodStartTrigger,
  reason: string,
  options: { only?: PodRoleId; signal?: AbortSignal } = {},
): Promise<PodTriggerReport> {
  const pods = options.only ? [options.only] : podsForTrigger(trigger);
  if (fleetMode() !== 'pods') {
    return { trigger, reason, mode: 'serverless', blocked: null, message: 'Serverless-Modus: Endpoints skalieren selbst', pods: [] };
  }
  if (!wakeEnabled()) {
    return remember({ trigger, reason, mode: 'pods', blocked: 'disabled', message: 'AI_FLEET_WAKE=0', pods: pods.map((pod) => ({ pod, state: rt(pod).state, block: 'disabled', startRequested: false })) });
  }
  const pending = pods.filter((pod) => rt(pod).state !== 'ready');
  if (pending.length === 0) {
    return { trigger, reason, mode: 'pods', blocked: null, pods: pods.map((pod) => ({ pod, state: 'ready', block: null, startRequested: rt(pod).startRequested })) };
  }

  aiLogger.info('fleet pod trigger', { trigger, reason, pods: pending });

  // AI-Schalter (INFRA-FEAT-001): bei „AI aus“ startet nichts.
  if (isAiDisabled()) {
    return remember(blockAll(pending, 'ai-off', 'AI ist ausgeschaltet (aiMONK = OFF) – kein Pod-Start.', trigger, reason));
  }
  if (killSwitchGuard()) {
    return remember(blockAll(pending, 'kill-switch', 'Kill-Switch aktiv – kein Pod-Start.', trigger, reason));
  }
  const notAllowed = pending.filter((pod) => !podAllowed(pod));
  if (notAllowed.length > 0) {
    blockAll(notAllowed, 'ai-off', 'Rolle im aktuellen AI-Modus gesperrt.', trigger, reason);
  }
  const allowed = pending.filter((pod) => podAllowed(pod));

  // Budget (AI_MAX_AI_EUR_PER_HOUR) VOR dem ersten Netzwerkaufruf.
  const afterStart = new Set<PodRoleId>([...activePods(), ...allowed]);
  const eurPerHour = podFleetEurPerHour(afterStart.size);
  const limit = podFleetMaxEurPerHour();
  if (eurPerHour > limit) {
    const message = `${afterStart.size} Pods kosten ${eurPerHour.toFixed(2)} €/h und übersteigen das AI-Budget von ${limit} €/h (AI_MAX_AI_EUR_PER_HOUR).`;
    return remember(blockAll(allowed, 'budget', message, trigger, reason));
  }

  const results = await Promise.all(allowed.map((pod) => wakePod(pod, trigger, reason, options.signal)));
  const byPod = new Map(results.map((res) => [res.pod, res]));
  const report: PodTriggerReport = {
    trigger,
    reason,
    mode: 'pods',
    blocked: null,
    pods: pods.map((pod) => byPod.get(pod) ?? { pod, state: rt(pod).state, block: rt(pod).block, startRequested: rt(pod).startRequested, message: rt(pod).error ?? undefined }),
  };
  aiLogger.info('fleet pod trigger finished', {
    trigger,
    reason,
    eurPerHour: Number(eurPerHour.toFixed(3)),
    pods: report.pods.map((p) => `${p.pod}:${p.state}`),
  });
  return remember(report);
}

/** Session-Start: RP1 brain + RP2 ears (immer an). */
export function onSessionStartPods(): Promise<PodTriggerReport> {
  return triggerPodStart('always', 'session-start');
}

/**
 * Plugin-Aktivität aus dem Realtime-Hub (Lock geholt bzw. Modus nicht OFF).
 * Nur der stemMONK startet einen Pod (RP5). Liefert null für andere Plugins.
 */
export function onPluginStarted(canonicalPluginId: string | null): Promise<PodTriggerReport> | null {
  if (canonicalPluginId !== 'stem') return null;
  if (rt('stems').state === 'ready' || rt('stems').inflight) return null;
  return triggerPodStart('stemMONK', 'stemMONK started');
}

export class PodWakeBlockedError extends Error {
  constructor(readonly pod: PodRoleId, readonly block: PodWakeBlock, message: string) {
    super(message);
    this.name = 'PodWakeBlockedError';
  }
}

/**
 * Vor jedem Job im Pod-Modus: Ziel-Pod bereit? Bereit = sofort zurück (keine
 * zusätzliche Latenz). Sonst Lazy-Wake: bei einem Generierungs-Auftrag startet
 * der Trigger `aiGeneration` beide Generierungs-Pods (music + voice), der Job
 * wartet nur auf seinen eigenen. Gesperrt (AI aus, Kill-Switch, Budget) →
 * `PodWakeBlockedError`. Nicht bereit geworden → der Job versucht es trotzdem
 * (der Provider meldet dann den echten Fehler).
 */
export async function ensurePodForJob(pod: PodRoleId, task: AiTask, signal?: AbortSignal): Promise<PodWakeResult> {
  const r = rt(pod);
  if (r.state === 'ready') return { pod, state: 'ready', block: null, startRequested: r.startRequested };
  const trigger = POD_START_TRIGGERS[pod];
  if (trigger === 'aiGeneration' && isAiGenerationTask(task)) {
    // Beide Generierungs-Pods anstoßen (Hintergrund), der Job wartet nur auf seinen.
    void triggerPodStart('aiGeneration', `first ai generation (${task})`).catch(() => { /* geloggt */ });
  }
  const report = await abortable(
    triggerPodStart(trigger, trigger === 'aiGeneration' && isAiGenerationTask(task) ? `first ai generation (${task})` : `lazy wake for job (${task})`, { only: pod }),
    signal,
  );
  const mine = report.pods.find((p) => p.pod === pod) ?? { pod, state: rt(pod).state, block: report.blocked, startRequested: false };
  if (mine.state === 'blocked' && mine.block && mine.block !== 'disabled') {
    throw new PodWakeBlockedError(pod, mine.block, report.message ?? mine.message ?? `Pod ${pod} gesperrt (${mine.block})`);
  }
  return mine;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Warten auf Pod abgebrochen'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Warten auf Pod abgebrochen'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/** Der Provider meldet: Pod nicht erreichbar → beim nächsten Job neu prüfen. */
export function markPodStale(pod: PodRoleId, why: string): void {
  const r = rt(pod);
  if (r.state !== 'ready') return;
  Object.assign(r, { state: 'off', readyAt: null, error: why });
  aiLogger.warn('fleet pod marked stale', { pod, error: why });
}

/** Zustand für fleetStatus() (kein Netzwerkaufruf). */
export function podStartTriggerStatus(): Record<string, unknown> {
  const active = activePods();
  return {
    mode: fleetMode(),
    wakeEnabled: wakeEnabled(),
    budget: {
      activePods: active.length,
      eurPerHour: Number(podFleetEurPerHour(active.length).toFixed(3)),
      maxEurPerHour: podFleetMaxEurPerHour(),
    },
    pods: POD_ROLE_IDS.map((pod) => {
      const r = rt(pod);
      return {
        pod,
        startTrigger: POD_START_TRIGGERS[pod],
        state: r.state,
        trigger: r.trigger,
        reason: r.reason,
        since: r.since,
        readyAt: r.readyAt,
        startRequested: r.startRequested,
        block: r.block,
        error: r.error,
        configured: Boolean(podBaseUrl(pod)),
      };
    }),
    lastTriggers: lastReports.map((rep) => ({ trigger: rep.trigger, reason: rep.reason, blocked: rep.blocked, pods: rep.pods.map((p) => `${p.pod}:${p.state}`) })),
  };
}

/** Nur für Tests. */
export function __resetPodStartTriggers(): void {
  runtimes = new Map(POD_ROLE_IDS.map((pod) => [pod, freshRuntime()]));
  killSwitchGuard = () => false;
  lastReports = [];
}
