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
import { podQueue, setJobFinishedHook } from './podJobQueue';
import { formatEurPerHour, podCostMeter } from './costTracker';
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
  /** Letzte beobachtete Aktivität (Wecken oder Auftrag) - Grundlage des Auto-Stops. */
  lastActivityAt: number | null;
}

export interface PodAutoStopReport {
  /** Zeitpunkt der Prüfung (Serverzeit). */
  checkedAt: number;
  idleMs: number;
  /** Pods, die als untätig erkannt wurden. */
  idle: PodRoleId[];
  stopped: PodRoleId[];
  failed: { pod: PodRoleId; message: string }[];
  /** Gesetzt, wenn gar nicht gestoppt werden durfte (Grund). */
  skipped: string | null;
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
  return { state: 'off', trigger: null, reason: null, since: null, readyAt: null, startRequested: false, block: null, error: null, inflight: null, lastActivityAt: null };
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

/** Pods, die laut lokalem Zustand laufen oder starten (Kosten fallen an). */
export function activePodIds(): PodRoleId[] {
  return activePods();
}

/** FLEET-P1-012: Kostenzähler an den lokalen Pod-Zustand angleichen. */
function syncCostMeter(): void {
  const count = activePods().length;
  podCostMeter.setRate(count, podFleetEurPerHour(count));
}

/**
 * FLEET-P1-012: Nach dem Terminieren durch den Auto-Stop sind die Pods weg.
 * Lokaler Zustand → `off`, Startvermerk gelöscht, Kostenzähler auf 0.
 */
export function markPodsTerminated(why: string): void {
  for (const pod of POD_ROLE_IDS) {
    const r = rt(pod);
    Object.assign(r, { state: 'off', readyAt: null, startRequested: false, block: null, error: why, trigger: null, reason: null, since: null });
  }
  syncCostMeter();
  aiLogger.info('fleet pod terminated (local state off)', { why, costLine: podCostMeter.status().costLine });
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
    // Der Abbruch-Listener muss nach dem normalen Aufloesen wieder abgehaengt werden:
    // die Poll-Schleifen rufen sleep bis zu ~120-mal am SELBEN Signal auf und
    // sammelten sonst Listener an, die nie gebraucht werden.
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function doWakePod(pod: PodRoleId, trigger: PodStartTrigger, reason: string, signal?: AbortSignal): Promise<PodWakeResult> {
  const r = rt(pod);
  const first = await probeReady(pod, signal);
  if (first.ok) {
    Object.assign(r, { state: 'ready', readyAt: Date.now(), lastActivityAt: Date.now(), error: null, block: null });
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
  let last = await probeReady(pod, signal); // sofort pruefen, nicht erst nach einer Warteperiode
  while (!last.ok && Date.now() < deadline && !signal?.aborted) {
    await sleep(Math.min(readyPollMs(), Math.max(0, deadline - Date.now())), signal);
    last = await probeReady(pod, signal);
  }
  if (last.ok) {
    Object.assign(r, { state: 'ready', readyAt: Date.now(), lastActivityAt: Date.now(), error: null, block: null });
    aiLogger.info('fleet pod ready', { pod, trigger, reason, startRequested: start.requested });
    return { pod, state: 'ready', block: null, startRequested: start.requested };
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
  syncCostMeter();
  const run = doWakePod(pod, trigger, reason, signal)
    .catch((error: unknown): PodWakeResult => {
      Object.assign(r, { state: 'failed', error: (error as Error).message });
      return { pod, state: 'failed', block: null, startRequested: false, message: (error as Error).message };
    })
    .finally(() => {
      r.inflight = null;
      syncCostMeter();
      notePodActivity(`pod ${pod} wake finished`);
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
  // FLEET-P1-012: Ein Trigger (Praesenz, Plugin, Auftrag) zaehlt als Aktivitaet -
  // fuer ALLE Pods des Triggers, nicht nur wenn alle schon bereit sind. Vorher stand
  // das nur im Fastpath: sind einige Pods pending, bekamen die bereits bereiten keine
  // Aktivitaet und der Sweeper konnte sie waehrend einer laufenden Nutzung stoppen.
  for (const pod of pods) markPodActivity(pod);
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
  // Der stems-Pod ist schon bereit: kein Start noetig, aber die Nutzung muss als
  // Aktivitaet gebucht werden - sonst stoppt der Leerlauf-Sweeper ihn mitten im Plugin.
  if (rt('stems').state === 'ready' || rt('stems').inflight) {
    markPodActivity('stems');
    return null;
  }
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
  notePodActivity(`job ${task} on ${pod}`);
  const r = rt(pod);
  // FLEET-P1-012: jeder Auftrag zaehlt als Aktivitaet - auch wenn der Pod schon
  // bereit ist und der Aufruf sofort zurueckkehrt.
  markPodActivity(pod);
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
  syncCostMeter();
  aiLogger.warn('fleet pod marked stale', { pod, error: why });
}

/**
 * Auto-Stop (FLEET-P1-012, Betreiber-Entscheid 2026-10-13: 15 Minuten).
 *
 * Ein Pod, der 15 Minuten weder geweckt wurde noch einen Auftrag gesehen hat,
 * wird gestoppt - sonst laeuft eine A40 weiter, obwohl niemand mehr im Studio
 * arbeitet. Der Wert steht in `AI_POD_AUTOSTOP_IDLE_MS` (Default 15 min).
 *
 * Gestoppt wird nur, was die Flotte selbst gestartet hat (`startRequested`) -
 * ein Pod, den der Betreiber von Hand gestartet hat, bleibt unberuehrt. Die
 * Entscheidung ist rein (kein Netzaufruf) und deshalb einzeln testbar; erst
 * `stopIdlePods` spricht die RunPod-REST-API an.
 */
export const POD_AUTOSTOP_IDLE_DEFAULT_MS = 15 * 60 * 1000;

export function podAutoStopIdleMs(): number {
  return envNumber('AI_POD_AUTOSTOP_IDLE_MS', POD_AUTOSTOP_IDLE_DEFAULT_MS);
}

/** Aktivitaet fuer einen Pod vermerken (Wecken oder laufender Auftrag). */
export function markPodActivity(pod: PodRoleId, atMs: number = Date.now()): void {
  rt(pod).lastActivityAt = atMs;
}

// Ein beendeter Auftrag zaehlt als Aktivitaet: das Leerlauf-Fenster laeuft ab dem
// Auftrags-ENDE, nicht ab dem Start. Ohne das stoppt ein Pod nach einem langen Lauf
// (LEGO, Stems, Song) unmittelbar nach dem Ergebnis und der Folgeauftrag zahlt den Kaltstart.
setJobFinishedHook((pod) => markPodActivity(pod));

/**
 * Ist gerade jemand im Studio? Solange ja, stoppt der Leerlauf-Aufraeumer nichts:
 * der Betreiber-Entscheid lautet "15 Minuten ohne Session ODER Auftrag". Die
 * Praesenz kommt aus dem Realtime-Hub (server.ts -> noteStudioPresence); ohne diese
 * Sperre konnte ein Pod mitten in einer laufenden Studio-Sitzung gestoppt werden
 * (Widerspruch zu RT-AUDIT-P1-015 "Brain warm halten, solange Nutzer im Studio sind").
 */
let studioSessionActive = false;

/** Session-Zustand setzen (Realtime-Hub). */
export function setStudioSessionActive(active: boolean): void {
  studioSessionActive = active;
}

/** Ist eine Studio-Session aktiv? (fuer Status und Tests) */
export function podSessionActive(): boolean {
  return studioSessionActive;
}

/**
 * Praesenzmeldung aus dem Realtime-Hub: Session-Zustand fuehren UND die bereiten Pods
 * als aktiv buchen. Ohne das zweite haelt der Sweeper die Flotte fuer untaetig, weil
 * Praesenz nur beim ersten Join als Aktivitaet zaehlte.
 */
export function noteStudioPresence(members: number): void {
  studioSessionActive = members > 0;
  if (members <= 0) return;
  for (const pod of POD_ROLE_IDS) {
    if (rt(pod).state === 'ready') markPodActivity(pod);
  }
}

/**
 * Untaetige Pods (reine Entscheidung, kein Netzaufruf).
 *
 * Kandidat ist ein Pod, den die Flotte selbst gestartet hat (`startRequested`) und der
 * weder laeuft noch wartet (`podBusy`), wenn seit der letzten Aktivitaet die Leerlaufzeit
 * vergangen ist. Zwei Faelle sind bewusst dabei:
 *  - `ready`: der Normalfall.
 *  - `starting`/`failed`: ein Pod, dessen /ready nie 200 wurde (Modell laedt nicht,
 *    Token falsch). Der wird bereits abgerechnet und wurde vorher NIE gestoppt - ein
 *    reines Kostenleck. Die Uhr laeuft ab `since` (Beginn des Weckversuchs).
 * Nicht gestoppt wird, waehrend jemand im Studio ist (`studioSessionActive`).
 */
export function autoStopCandidates(nowMs: number, idleMs: number = podAutoStopIdleMs()): PodRoleId[] {
  if (studioSessionActive) return [];
  return POD_ROLE_IDS.filter((pod) => {
    const r = rt(pod);
    if (!r.startRequested) return false; // fremd gestartete Pods nicht anfassen
    if (r.state !== 'ready' && r.state !== 'starting' && r.state !== 'failed') return false;
    if (podBusy(pod)) return false; // laufender/gewarteter Auftrag schuetzt den Pod
    const since = r.lastActivityAt ?? r.readyAt ?? r.since;
    if (since === null) return false;
    return nowMs - since >= idleMs;
  });
}

/**
 * Laeuft oder wartet gerade ein Auftrag auf dem Pod? Der Sweeper darf einen
 * beschaeftigten Pod nicht stoppen: ein Video-/LEGO-Lauf dauert laenger als die
 * Leerlaufzeit, und ein wartender Auftrag hat den Pod gerade erst angefordert.
 */
export function podBusy(pod: PodRoleId): boolean {
  const queue = podQueue(pod);
  return queue.runningCount() > 0 || queue.waitingCount() > 0;
}

/** Ist das Herunterfahren per AI_FLEET_SLEEP abgeschaltet? Dann auch kein Auto-Stop. */
function sleepDisabled(): boolean {
  const raw = (process.env.AI_FLEET_SLEEP ?? '').trim().toLowerCase();
  return raw !== '' && ['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * Nach einem Serverneustart laufen die Pods weiter, der Modulzustand ist aber weg:
 * `startRequested` waere false und der Sweeper wuerde sie nie aufraeumen. Deshalb
 * einmal beim Start die eigenen Pod-IDs bei RunPod abfragen und laufende adoptieren
 * (mit Aktivitaetszeitpunkt = jetzt, damit die 15 Minuten ab Adoption zaehlen).
 */
export async function adoptRunningPods(signal?: AbortSignal): Promise<PodRoleId[]> {
  if (fleetMode() !== 'pods' || !wakeEnabled()) return [];
  const adopted: PodRoleId[] = [];
  for (const pod of POD_ROLE_IDS) {
    const id = podId(pod);
    if (!id || rt(pod).state === 'ready') continue;
    try {
      const resp = await fetch(`${restBase()}/pods/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        signal,
      });
      if (!resp.ok) continue;
      const body = (await resp.json()) as { desiredStatus?: string; status?: string };
      if (String(body.desiredStatus).toUpperCase() !== 'RUNNING') continue;
      const r = rt(pod);
      Object.assign(r, {
        state: 'ready', readyAt: Date.now(), lastActivityAt: Date.now(),
        startRequested: true, error: null, block: null, trigger: null, reason: 'adopted',
      });
      adopted.push(pod);
      aiLogger.info('fleet pod adopted', { pod, id, status: body.status ?? null });
    } catch (error) {
      aiLogger.warn('fleet pod adopt failed', { pod, id, error: (error as Error).message });
    }
  }
  return adopted;
}

/** Takt des Leerlauf-Aufraeumers (`AI_POD_AUTOSTOP_SWEEP_MS`, Default 60 s). */
export const POD_AUTOSTOP_SWEEP_DEFAULT_MS = 60 * 1000;

export function podAutoStopSweepMs(): number {
  return envNumber('AI_POD_AUTOSTOP_SWEEP_MS', POD_AUTOSTOP_SWEEP_DEFAULT_MS);
}

/** Soll der Leerlauf-Aufraeumer ueberhaupt laufen? (Serverless oder AI_FLEET_SLEEP=0: nein) */
export function podAutoStopActive(): boolean {
  return fleetMode() === 'pods' && !sleepDisabled();
}

/** Untaetige Pods stoppen; meldet je Pod, was passiert ist (kein Wurf). */
export async function stopIdlePods(nowMs: number = Date.now(), signal?: AbortSignal): Promise<PodAutoStopReport> {
  const idleMs = podAutoStopIdleMs();
  const report: PodAutoStopReport = { checkedAt: nowMs, idleMs, idle: [], stopped: [], failed: [], skipped: null };
  if (fleetMode() !== 'pods') {
    report.skipped = 'fleet-mode';
    return report;
  }
  if (!wakeEnabled()) {
    report.skipped = 'wake-disabled';
    return report;
  }
  // AI_FLEET_SLEEP=0 schaltet das Herunterfahren ab - dann stoppt auch der Sweep nicht.
  // Vorher hing der Auto-Stop nur an AI_FLEET_WAKE, sodass AI_FLEET_SLEEP=0 wirkungslos war.
  if (sleepDisabled()) {
    report.skipped = 'sleep-disabled';
    return report;
  }
  const candidates = autoStopCandidates(nowMs, idleMs);
  report.idle = candidates;
  for (const pod of candidates) {
    const id = podId(pod);
    const r = rt(pod);
    const idleForMs = nowMs - (r.lastActivityAt ?? r.readyAt ?? r.since ?? nowMs);
    // TOCTOU: zwischen Kandidatenwahl und diesem Stop kann ein Auftrag gestartet sein
    // (oder jemand ins Studio gekommen sein). Deshalb unmittelbar vor dem Aufruf erneut pruefen.
    if (podBusy(pod) || studioSessionActive) {
      report.skipped = report.skipped ?? 'busy-again';
      continue;
    }
    if (!id) {
      report.failed.push({ pod, message: `RP_POD_ID_${pod.toUpperCase()} fehlt` });
      continue;
    }
    try {
      const resp = await fetch(`${restBase()}/pods/${encodeURIComponent(id)}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const wasReadyAt = r.readyAt;
      Object.assign(r, { state: 'off', readyAt: null, lastActivityAt: null, error: null, trigger: null, reason: null, since: wasReadyAt });
      report.stopped.push(pod);
      aiLogger.info('fleet pod stopped (idle)', { pod, idleForMs, idleMs });
    } catch (error) {
      const message = (error as Error).message;
      report.failed.push({ pod, message });
      aiLogger.warn('fleet pod stop failed', { pod, idleForMs, error: message });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// FLEET-P1-012: Aktivitätssignal für den Idle-Timer des Auto-Stops
// ---------------------------------------------------------------------------
let activityListener: ((why: string) => void) | null = null;

/** Der Auto-Stop (fleetAutostop.ts) hängt sich hier an; null hängt ab. */
export function setPodActivityListener(fn: ((why: string) => void) | null): void {
  activityListener = fn;
}

/** Ein Pod wurde benutzt (Job-Start/-Ende, Wake). Nie werfend, nie blockierend. */
export function notePodActivity(why: string): void {
  try {
    activityListener?.(why);
  } catch (error) {
    aiLogger.warn('fleet pod activity listener failed', { error: (error as Error).message });
  }
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
      // FLEET-P1-012: Kostenzeile (deutsch) + laufender Zähler.
      costLine: formatEurPerHour(podFleetEurPerHour(active.length)),
      meter: podCostMeter.status(),
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
        lastActivityAt: r.lastActivityAt,
      };
    }),
    autoStop: {
      idleMs: podAutoStopIdleMs(),
      sweepMs: podAutoStopSweepMs(),
      candidates: autoStopCandidates(Date.now(), podAutoStopIdleMs()),
      busy: POD_ROLE_IDS.filter((pod) => podBusy(pod)),
    },
    lastTriggers: lastReports.map((rep) => ({ trigger: rep.trigger, reason: rep.reason, blocked: rep.blocked, pods: rep.pods.map((p) => `${p.pod}:${p.state}`) })),
  };
}

/** Nur für Tests. */
export function __resetPodStartTriggers(): void {
  runtimes = new Map(POD_ROLE_IDS.map((pod) => [pod, freshRuntime()]));
  killSwitchGuard = () => false;
  lastReports = [];
  podCostMeter.reset();
}

/** Kill-Switch-Zustand (für den Auto-Stop-Status; Stoppen ist nie gesperrt). */
export function podKillSwitchActive(): boolean {
  try {
    return killSwitchGuard();
  } catch {
    return false;
  }
}
