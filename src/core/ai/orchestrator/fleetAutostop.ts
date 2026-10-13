/**
 * audioMONASTRY · Auto-Stop der RunPod-Pods mit Snapshot (FLEET-P1-012)
 * =====================================================================
 * Betreiber-Auftrag 2026-10-13: „Auto-Stop mit Snapshot und Kostensenkung auf
 * 0 €/h“. Vorher starteten die Pods per Trigger (podStartTriggers.ts), wurden
 * aber nie wieder beendet – `sleepFleet()` tat im Pod-Modus nichts.
 *
 * ABSCHALTSEQUENZ (feste Reihenfolge, im Bericht unter `steps` belegt):
 *   1. checkpoint  Session-/Studio-Zustand serverseitig schreiben UND prüfen
 *                  (server/sessionRuntime.ts `checkpoint()`: Persistenz-Save +
 *                  Snapshot mit Prüfsumme, Rücklesen des Snapshots).
 *   2. list        `GET /pods` – nur Pods mit Namenspräfix `audiomonastry-pod-`
 *                  (Quelle: deploy/runpod/pod-fleet.json `namePrefix`), nie
 *                  fremde Pods.
 *   3. terminate   `DELETE /pods/<id>` je eigenem Pod. Bewusst TERMINATE, nicht
 *                  STOP: ein gestoppter RunPod-Pod berechnet seine Disk weiter
 *                  (≠ 0 €/h). Die Gewichte kommen beim nächsten Anlegen aus dem
 *                  R2-Spiegel (scripts/runpod/weights-mirror.py,
 *                  `runpod-pods.py up`).
 *   4. verify      erneut `GET /pods`: kein eigener Pod mehr aktiv → lokaler
 *                  Zustand `off`, Kostenzähler 0,00 €/h (CostTracker stoppt).
 *
 * AUSLÖSER:
 *   * Presence: letzter Nutzer verlässt das Studio → nach der Karenz
 *     (`AI_FLEET_AUTOSTOP_GRACE_MS`, sonst `AI_BRAIN_KEEPWARM_GRACE_MS`,
 *     Default 15 min). Rückkehr innerhalb der Karenz bricht ab (fleetWake.ts);
 *     eine Rückkehr während der Sequenz bricht VOR dem Terminieren ab.
 *   * Idle: Pods wurden durch einen Auftrag gestartet, aber niemand ist im
 *     Studio → nach `AI_FLEET_AUTOSTOP_IDLE_MS` (Default 15 min) ohne
 *     Job-Aktivität und mit leerer Warteschlange.
 *
 * ABSICHERUNGEN:
 *   * `AI_FLEET_AUTOSTOP=0` schaltet den Auto-Stop ab (Default an, nur im
 *     Pod-Modus `AI_FLEET_MODE=pods`).
 *   * `AI_FLEET_AUTOSTOP_DRYRUN=1`: Checkpoint und Liste laufen, terminiert
 *     wird nichts (`wouldTerminate` im Bericht).
 *   * AI-Schalter, Kill-Switch und Budget sperren nur das STARTEN. Stoppen
 *     senkt Kosten und ist deshalb nie gesperrt (wie `sleepFleet`).
 *   * Idempotent: ein laufender Lauf wird geteilt; bereits beendete Pods
 *     (404 / nicht mehr gelistet) zählen als erledigt.
 *   * Fehlerpfad: Retry (`AI_FLEET_AUTOSTOP_RETRIES`, Default 3, Abstand
 *     `AI_FLEET_AUTOSTOP_RETRY_MS`, Default 2 000 ms), danach laute Warnung
 *     (aiLogger.error + console.error) und Alarm über den Server-Hook
 *     (server.ts → bestehende Alarmzustellung Discord/Slack/Telegram).
 *
 * Kein Audio-Pfad: alles läuft in Timern/Promises im Hintergrund.
 */
import { aiLogger } from './aiLogger';
import { formatEurPerHour, podCostMeter } from './costTracker';
import { podQueueStatus } from './podJobQueue';
import { fleetMode } from './podRouting';
import {
  activePodIds,
  markPodsTerminated,
  podFleetEurPerHour,
  podKillSwitchActive,
  setPodActivityListener,
} from './podStartTriggers';

/** Namenspräfix der eigenen Pods (Spiegel von pod-fleet.json `namePrefix`, Drift-Test). */
export const POD_NAME_PREFIX = 'audiomonastry-pod-';

export type AutostopReason = 'presence-grace' | 'idle-no-jobs' | 'sleep-fleet' | 'manual';
export type AutostopAbort = 'disabled' | 'serverless' | 'rejoined' | 'jobs-running';
export type AutostopStep = 'checkpoint' | 'list' | 'terminate' | 'verify';

/** Nachweis, dass der Session-Zustand vor dem Stop geschrieben wurde. */
export interface CheckpointProof {
  ok: boolean;
  revision?: number;
  snapshotId?: string;
  checksum?: string;
  savedAt?: number;
  /** Snapshot zurückgelesen und Prüfsumme gültig. */
  verified?: boolean;
  /** Art der Persistenz (redis/file/memory/supabase …). */
  persistence?: string;
  error?: string;
}

export interface FleetPodInfo {
  id: string;
  name: string;
  desiredStatus: string;
}

export interface AutostopReport {
  reason: AutostopReason;
  startedAt: number;
  durationMs: number;
  dryRun: boolean;
  ok: boolean;
  aborted: AutostopAbort | null;
  /** Tatsächlich ausgeführte Schritte, in Reihenfolge (Nachweis Snapshot → Stop). */
  steps: AutostopStep[];
  checkpoint: CheckpointProof | null;
  /** Eigene, nicht terminierte Pods vor dem Stop. */
  listed: FleetPodInfo[];
  /** Fremde Pods im Konto (gesehen, nie angefasst). */
  foreignSkipped: number;
  terminated: string[];
  alreadyGone: string[];
  wouldTerminate: string[];
  failed: Array<{ id: string; name: string; error: string }>;
  /** Eigene Pods, die nach dem Stop noch aktiv gelistet sind. */
  remaining: number;
  eurPerHourAfter: number;
  costLine: string;
  /** Wurde ein Alarm ausgelöst? */
  alarm: boolean;
  error?: string;
}

export interface FleetAutostopHooks {
  /** Session-/Studio-Zustand schreiben + prüfen (server.ts → sessionRuntime.checkpoint). */
  checkpoint?: () => Promise<CheckpointProof>;
  /** Bestehende Alarmierung (server.ts). Fehler hier stören den Stop nie. */
  alarm?: (message: string, details: Record<string, unknown>) => void | Promise<void>;
}

function env(name: string): string {
  if (typeof process === 'undefined' || !process.env) return '';
  return (process.env[name] ?? '').trim();
}

function flagOn(name: string, fallback: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function envMs(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Auto-Stop aktiv? Nur im Pod-Modus; `AI_FLEET_AUTOSTOP=0` schaltet ab. */
export function autostopEnabled(): boolean {
  return fleetMode() === 'pods' && flagOn('AI_FLEET_AUTOSTOP', true);
}

export function autostopDryRun(): boolean {
  return flagOn('AI_FLEET_AUTOSTOP_DRYRUN', false);
}

/** Karenz nach dem letzten Leave (eigene Variable, sonst die des Brain-Warmhaltens). */
export function autostopGraceMs(): number {
  return envMs('AI_FLEET_AUTOSTOP_GRACE_MS', envMs('AI_BRAIN_KEEPWARM_GRACE_MS', 900_000));
}

/** Idle-Fenster ohne Jobs bei leerer Session. */
export function autostopIdleMs(): number {
  return envMs('AI_FLEET_AUTOSTOP_IDLE_MS', 900_000);
}

function retries(): number {
  return Math.max(1, Math.min(10, Math.floor(envMs('AI_FLEET_AUTOSTOP_RETRIES', 3))));
}

function retryMs(): number {
  return envMs('AI_FLEET_AUTOSTOP_RETRY_MS', 2_000);
}

function restBase(): string {
  return (env('RUNPOD_REST_BASE') || 'https://rest.runpod.io/v1').replace(/\/+$/, '');
}

/** Wie `runpod-pods.py`: der volle Key zuerst (Terminieren braucht Schreibrechte). */
function apiKey(): string {
  return env('RP_API_KEY') || env('RUNPOD_API_KEY') || env('RP_AGENT_KEY');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

let hooks: FleetAutostopHooks = {};
let membersSource: () => number = () => 0;
let inflight: Promise<AutostopReport> | null = null;
let lastReport: AutostopReport | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivityAt: number | null = null;
let runs = 0;

/** Server-Verdrahtung: Checkpoint und Alarm. */
export function setFleetAutostopHooks(next: FleetAutostopHooks): void {
  hooks = { ...next };
}

/** fleetWake.ts meldet hier, woher die Mitgliederzahl kommt (keine Zirkel-Imports). */
export function setAutostopMembersSource(fn: () => number): void {
  membersSource = fn;
}

function members(): number {
  try {
    return Math.max(0, Math.floor(Number(membersSource()) || 0));
  } catch {
    return 0;
  }
}

function jobsInFlight(): number {
  return podQueueStatus().reduce((sum, q) => sum + q.running.length + q.waiting.length, 0);
}

// ---------------------------------------------------------------------------
// RunPod REST (nur über fetch – in Tests gemockt)
// ---------------------------------------------------------------------------

class AutostopHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AutostopHttpError';
  }
}

async function listAccountPods(): Promise<{ own: FleetPodInfo[]; foreign: number }> {
  const key = apiKey();
  if (!key) throw new Error('RunPod-Key fehlt (RP_API_KEY/RUNPOD_API_KEY/RP_AGENT_KEY) – Pods können nicht beendet werden');
  const resp = await fetch(`${restBase()}/pods`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new AutostopHttpError(resp.status, `Pod-Liste HTTP ${resp.status}`);
  const data = (await resp.json().catch(() => null)) as unknown;
  if (!Array.isArray(data)) throw new Error('Pod-Liste nicht lesbar (kein Array)');
  const own: FleetPodInfo[] = [];
  let foreign = 0;
  for (const raw of data) {
    const item = (raw ?? {}) as { id?: unknown; name?: unknown; desiredStatus?: unknown };
    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name : '';
    const desiredStatus = typeof item.desiredStatus === 'string' ? item.desiredStatus : '';
    if (!id) continue;
    if (!name.startsWith(POD_NAME_PREFIX)) {
      foreign += 1;
      continue;
    }
    if (desiredStatus.toUpperCase() === 'TERMINATED') continue;
    own.push({ id, name, desiredStatus });
  }
  return { own, foreign };
}

async function terminatePod(pod: FleetPodInfo): Promise<'terminated' | 'gone'> {
  // Doppelte Sicherung: auch hier nur eigene Pods und nur saubere IDs.
  if (!pod.name.startsWith(POD_NAME_PREFIX)) throw new Error(`fremder Pod ${pod.name} – nicht angefasst`);
  if (!/^[a-z0-9]{6,40}$/i.test(pod.id)) throw new Error(`ungültige Pod-ID ${pod.id}`);
  const resp = await fetch(`${restBase()}/pods/${encodeURIComponent(pod.id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (resp.status === 404) return 'gone';
  if ([200, 202, 204].includes(resp.status)) return 'terminated';
  throw new AutostopHttpError(resp.status, `Terminate HTTP ${resp.status}`);
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const attempts = retries();
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      aiLogger.warn('fleet autostop retry', { step: label, attempt, attempts, error: (error as Error).message });
      if (attempt < attempts) await wait(retryMs());
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function raiseAlarm(report: AutostopReport, message: string): Promise<void> {
  report.alarm = true;
  // Laut: eigene Fehlerzeile UND strukturierter Log (aiLogger).
  console.error(`[fleet-autostop] ALARM: ${message} – Pods laufen evtl. weiter und kosten Geld. `
    + 'Manuell: python3 scripts/runpod-pods.py status / down --yes');
  aiLogger.error('fleet autostop FAILED', {
    reason: report.reason,
    message,
    failed: report.failed,
    remaining: report.remaining,
    checkpointOk: report.checkpoint?.ok ?? null,
  });
  try {
    await hooks.alarm?.(message, {
      reason: report.reason,
      failed: report.failed,
      remaining: report.remaining,
      checkpoint: report.checkpoint,
    });
  } catch (error) {
    aiLogger.error('fleet autostop alarm delivery failed', { error: (error as Error).message });
  }
}

function emptyReport(reason: AutostopReason, startedAt: number): AutostopReport {
  return {
    reason,
    startedAt,
    durationMs: 0,
    dryRun: autostopDryRun(),
    ok: false,
    aborted: null,
    steps: [],
    checkpoint: null,
    listed: [],
    foreignSkipped: 0,
    terminated: [],
    alreadyGone: [],
    wouldTerminate: [],
    failed: [],
    remaining: 0,
    eurPerHourAfter: podCostMeter.status().eurPerHour,
    costLine: podCostMeter.status().costLine,
    alarm: false,
  };
}

function finish(report: AutostopReport): AutostopReport {
  report.durationMs = Date.now() - report.startedAt;
  lastReport = report;
  aiLogger.info('fleet autostop finished', {
    reason: report.reason,
    ok: report.ok,
    aborted: report.aborted,
    dryRun: report.dryRun,
    steps: report.steps,
    terminated: report.terminated,
    alreadyGone: report.alreadyGone,
    wouldTerminate: report.wouldTerminate,
    failed: report.failed.map((f) => `${f.name}:${f.error}`),
    foreignSkipped: report.foreignSkipped,
    checkpoint: report.checkpoint ? { ok: report.checkpoint.ok, snapshotId: report.checkpoint.snapshotId, revision: report.checkpoint.revision, verified: report.checkpoint.verified } : null,
    costLine: report.costLine,
    durationMs: report.durationMs,
  });
  return report;
}

async function runCheckpoint(report: AutostopReport): Promise<void> {
  report.steps.push('checkpoint');
  if (!hooks.checkpoint) {
    report.checkpoint = { ok: false, error: 'kein Checkpoint-Hook verdrahtet (server.ts)' };
    aiLogger.warn('fleet autostop: no checkpoint hook', { reason: report.reason });
    return;
  }
  try {
    report.checkpoint = await withRetry('checkpoint', async () => {
      const proof = await hooks.checkpoint!();
      if (!proof.ok) throw new Error(proof.error ?? 'Checkpoint meldet ok=false');
      return proof;
    });
    aiLogger.info('fleet autostop: session checkpoint written', {
      snapshotId: report.checkpoint.snapshotId,
      revision: report.checkpoint.revision,
      verified: report.checkpoint.verified,
      persistence: report.checkpoint.persistence,
    });
  } catch (error) {
    report.checkpoint = { ok: false, error: (error as Error).message };
    // Die Pods halten KEINEN Session-Zustand (der liegt auf dem App-Server);
    // sie trotzdem zu beenden verliert nichts, spart aber Geld. Der fehlende
    // Snapshot wird laut gemeldet – der Intervall-Snapshot läuft weiter.
    await raiseAlarm(report, `Session-Checkpoint vor dem Pod-Stop fehlgeschlagen: ${(error as Error).message}`);
  }
}

async function doAutostop(reason: AutostopReason, force: boolean): Promise<AutostopReport> {
  runs += 1;
  const report = emptyReport(reason, Date.now());
  if (fleetMode() !== 'pods') {
    report.aborted = 'serverless';
    report.ok = true;
    return finish(report);
  }
  if (!autostopEnabled()) {
    report.aborted = 'disabled';
    report.ok = true;
    return finish(report);
  }
  if (!force && members() > 0) {
    report.aborted = 'rejoined';
    report.ok = true;
    return finish(report);
  }
  if (!force && jobsInFlight() > 0) {
    report.aborted = 'jobs-running';
    report.ok = true;
    aiLogger.info('fleet autostop deferred: jobs in flight', { reason, jobs: jobsInFlight() });
    armIdleTimer('autostop deferred (jobs running)');
    return finish(report);
  }

  aiLogger.info('fleet autostop: shutdown sequence started', {
    reason,
    dryRun: report.dryRun,
    killSwitch: podKillSwitchActive(),
    graceMs: autostopGraceMs(),
  });

  // 1. Snapshot VOR dem Beenden.
  await runCheckpoint(report);

  // Rückkehr während des Checkpoints → abbrechen, bevor etwas beendet wird.
  if (!force && members() > 0) {
    report.aborted = 'rejoined';
    report.ok = true;
    aiLogger.info('fleet autostop aborted: member rejoined before terminate', { reason, members: members() });
    return finish(report);
  }

  // 2. Eigene Pods auflisten.
  report.steps.push('list');
  let own: FleetPodInfo[];
  try {
    const listing = await withRetry('list', listAccountPods);
    own = listing.own;
    report.listed = own;
    report.foreignSkipped = listing.foreign;
  } catch (error) {
    report.error = (error as Error).message;
    await raiseAlarm(report, `Pod-Liste nicht lesbar, Auto-Stop nicht möglich: ${report.error}`);
    return finish(report);
  }

  if (report.dryRun) {
    report.wouldTerminate = own.map((p) => p.name);
    report.ok = true;
    aiLogger.info('fleet autostop DRY-RUN: would terminate', { pods: report.wouldTerminate, foreignSkipped: report.foreignSkipped });
    return finish(report);
  }

  // 3. Terminieren (nicht stoppen: gestoppte Pods kosten Disk).
  report.steps.push('terminate');
  for (const pod of own) {
    try {
      const outcome = await withRetry(`terminate ${pod.name}`, () => terminatePod(pod));
      (outcome === 'gone' ? report.alreadyGone : report.terminated).push(pod.name);
      aiLogger.info('fleet autostop: pod terminated', { pod: pod.name, id: pod.id, outcome });
    } catch (error) {
      report.failed.push({ id: pod.id, name: pod.name, error: (error as Error).message });
    }
  }

  // 4. Prüfen: kein eigener Pod mehr aktiv.
  report.steps.push('verify');
  try {
    const after = await withRetry('verify', listAccountPods);
    report.remaining = after.own.length;
  } catch (error) {
    report.remaining = report.failed.length || own.length;
    report.error = `Nachprüfung fehlgeschlagen: ${(error as Error).message}`;
  }

  if (report.failed.length === 0 && report.remaining === 0 && !report.error) {
    markPodsTerminated(`autostop (${reason})`);
    lastActivityAt = null;
    report.ok = true;
  } else {
    await raiseAlarm(
      report,
      report.error
        ?? `${report.failed.length} Pod(s) nicht beendet, ${report.remaining} noch aktiv (${report.failed.map((f) => `${f.name}: ${f.error}`).join('; ') || 'Liste'})`,
    );
  }
  const status = podCostMeter.status();
  report.eurPerHourAfter = status.eurPerHour;
  report.costLine = status.costLine;
  return finish(report);
}

/**
 * Startet die Abschaltsequenz (Checkpoint → Liste → Terminate → Prüfung).
 * Parallele Aufrufe teilen sich denselben Lauf (idempotent). `force` (nur
 * manuell) überspringt die Presence-/Job-Prüfung.
 */
export function runFleetAutostop(reason: AutostopReason, options: { force?: boolean } = {}): Promise<AutostopReport> {
  if (inflight) return inflight;
  cancelIdleTimer();
  inflight = doAutostop(reason, options.force === true)
    .catch(async (error: unknown) => {
      // Darf nie still sterben.
      const report = emptyReport(reason, Date.now());
      report.error = (error as Error).message;
      await raiseAlarm(report, `Auto-Stop abgebrochen: ${report.error}`);
      return finish(report);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---------------------------------------------------------------------------
// Idle-Timer: Pods durch Auftrag gestartet, Session leer, keine Jobs
// ---------------------------------------------------------------------------

function cancelIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdleTimer(why: string, delayMs = autostopIdleMs()): void {
  if (!autostopEnabled()) return;
  if (members() > 0) return;
  cancelIdleTimer();
  const timer = setTimeout(() => {
    idleTimer = null;
    onIdleTimer();
  }, Math.max(0, delayMs));
  (timer as { unref?: () => void }).unref?.();
  idleTimer = timer;
  aiLogger.info('fleet autostop: idle timer armed', { why, idleMs: delayMs });
}

function onIdleTimer(): void {
  if (members() > 0) return; // Session aktiv → das Presence-Gate übernimmt.
  if (jobsInFlight() > 0) {
    armIdleTimer('jobs still running');
    return;
  }
  const idleMs = autostopIdleMs();
  const since = lastActivityAt ?? 0;
  const elapsed = Date.now() - since;
  if (lastActivityAt !== null && elapsed < idleMs) {
    armIdleTimer('activity within idle window', idleMs - elapsed);
    return;
  }
  void runFleetAutostop('idle-no-jobs');
}

/** Pod-Aktivität (Job/Wake). Bei leerer Session startet bzw. verlängert sie den Idle-Timer. */
export function noteFleetActivity(why: string): void {
  lastActivityAt = Date.now();
  if (members() === 0) armIdleTimer(why);
}

setPodActivityListener(noteFleetActivity);

/**
 * Presence aus fleetWake.ts: jemand ist im Studio → Idle-Timer verwerfen
 * (die Karenz nach dem letzten Leave läuft in fleetWake).
 */
export function onAutostopPresence(memberCount: number): void {
  if (memberCount > 0) cancelIdleTimer();
}

/** Zustand für fleetStatus() (kein Netzwerkaufruf). */
export function fleetAutostopStatus(): Record<string, unknown> {
  const active = activePodIds();
  const meter = podCostMeter.status();
  return {
    enabled: autostopEnabled(),
    dryRun: autostopDryRun(),
    graceMs: autostopGraceMs(),
    idleMs: autostopIdleMs(),
    namePrefix: POD_NAME_PREFIX,
    running: inflight !== null,
    idleTimerArmed: idleTimer !== null,
    lastActivityAt,
    runs,
    runningPods: active.length,
    eurPerHour: Number(podFleetEurPerHour(active.length).toFixed(3)),
    costLine: formatEurPerHour(podFleetEurPerHour(active.length)),
    costMeter: meter,
    lastReport,
  };
}

/** Nur für Tests. */
export function __resetFleetAutostop(): void {
  cancelIdleTimer();
  inflight = null;
  lastReport = null;
  lastActivityAt = null;
  runs = 0;
  hooks = {};
}
