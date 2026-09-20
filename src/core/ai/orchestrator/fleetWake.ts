/**
 * audioMONASTRY · AI-Orchestrator – Session-Wake der GPU-Flotte
 * =============================================================
 * Die acht Serverless-Endpoints (siehe endpointRegistry.ts) skalieren auf 0,
 * damit im Idle keine GPU-Kosten entstehen. Der Preis dafür ist ein Kaltstart
 * beim ersten Task eines Tages. Da die App selbst 5–10 min zum Hochfahren
 * braucht, wird der Kaltstart versteckt:
 *
 *   1. `wakeFleet()` setzt `workersMin` je Endpoint temporär auf 1 (best effort,
 *      RunPod REST) und feuert – bei Rollen mit `warmupMode: 'task'` – einen
 *      `warmup`-Job, der die Preload-Modelle des Rollen-Manifests in VRAM lädt.
 *   2. Ist die Flotte warm, treffen echte Tasks keine Modell-Ladezeit mehr.
 *   3. `sleepFleet()` setzt `workersMin` zurück auf 0 – aufgerufen beim
 *      Session-Ende bzw. Idle-Timeout (SessionManager.onScaleToZero).
 *
 * Rollen mit `warmupMode: 'endpoint'` (die vorgefertigten ComfyUI-/Hub-Worker
 * für music/imageHq/videoReal/videoAbstract) kennen unseren `warmup`-Task NICHT –
 * Wecken ist dort nur `workersMin=1`, ein Warmup-Job würde als ungültiger
 * Request enden.
 *
 * DREI KANTEN, DIE HIER DURCHGESETZT WERDEN (Konstitution §2/§4):
 *
 *   * **AI-Schalter (INFRA-FEAT-001):** Der Betriebsmodus aus `aiGate.ts` ist
 *     bindend. Bei `off` wird die Flotte GAR NICHT geweckt (kein PATCH, kein
 *     RunPod-Request); Schlafenlegen bleibt erlaubt (es senkt nur die Kosten).
 *   * **Visual-Regel (INFRA-FEAT-002):** `wakeFleet()` weckt nur die
 *     immer-Rollen. Visual-Rollen (imageHq/videoReal/videoAbstract) starten
 *     ausschließlich bei Abruf – `wakeRoleOnDemand()` – und fallen danach per
 *     Idle-Timer wieder auf `workersMin=0`.
 *   * **Budget (INFRA-FEAT-003):** Vor jedem Netzwerkaufruf prüft
 *     `assertFleetHourlyBudget` die laufenden Kosten inkl. Hetzner-Anteil.
 *
 * Konfiguration:
 *   RP_ENDPOINT_ID_<ROLLE>   (Fallback: RP_ENDPOINT_ID)
 *   RP_AGENT_KEY | RP_API_KEY | RUNPOD_API_KEY
 *   RUNPOD_REST_BASE      (Default https://rest.runpod.io/v1)
 *   AI_FLEET_WAKE=0       deaktiviert das Aufwecken (kein Netzwerkverkehr)
 *   AI_FLEET_SLEEP=0      deaktiviert das Zurücksetzen
 *   AI_VISUAL_IDLE_MS     Idle-Fenster der Visual-Rollen (Default 900_000)
 */
import type { GpuRoleId } from '../../../config/aiInfrastructure';
import {
  AI_HETZNER_EUR_PER_HOUR,
  alwaysOnRoles,
  assertFleetHourlyBudget,
  estimateFleetEurPerHour,
  fleetBudgetReport,
  isVisualRole,
} from '../../../config/aiInfrastructure';
import { aiGateStatus, isAiDisabled, isRoleAllowed, roleBlockCode } from '../aiGate';
import { aiLogger } from './aiLogger';
import { resolveGpuRoles, type GpuRoleDefinition, type ResolvedGpuRole } from './endpointRegistry';
import { RunPodProvider, type WarmupResult } from './runpodProvider';

const DEFAULT_REST_BASE = 'https://rest.runpod.io/v1';

/** Grund, warum ein Flotten-Lauf gar nicht erst gestartet wurde. */
export type FleetBlockReason = 'ai-off' | 'visuals-off' | 'budget';

/** Status einer Rolle nach einem Wake-/Sleep-Lauf. */
interface FleetRoleStatus {
  role: GpuRoleId;
  endpointId: string;
  configured: boolean;
  /** Konnte `workersMin` gesetzt werden? (best effort) */
  workersMinSet: boolean;
  /** `task` = Warmup-Job möglich; `endpoint` = nur workersMin. */
  warmupMode: GpuRoleDefinition['warmupMode'];
  warmup: WarmupResult | null;
  error?: string;
  /** Rolle war von diesem Lauf absichtlich ausgenommen (kein Fehler). */
  skipped?: boolean;
}

/** Ergebnis eines Flotten-Laufs. */
export interface FleetReport {
  action: 'wake' | 'sleep';
  startedAt: number;
  durationMs: number;
  ok: boolean;
  /** Gesetzt, wenn AI-Modus oder Budget den Lauf verhindert haben. */
  blocked: FleetBlockReason | null;
  /** Klartext zum Block (Log/Statusantwort). */
  reason?: string;
  roles: FleetRoleStatus[];
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function restBase(): string {
  return (env('RUNPOD_REST_BASE') || DEFAULT_REST_BASE).replace(/\/+$/, '');
}

function apiKey(): string {
  return env('RP_AGENT_KEY') || env('RP_API_KEY') || env('RUNPOD_API_KEY');
}

function flagEnabled(name: string): boolean {
  const raw = env(name);
  if (!raw) return true;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

/** Idle-Fenster, nach dem eine bei Abruf gestartete Visual-Rolle auf 0 fällt. */
export function visualIdleMs(): number {
  const raw = Number(env('AI_VISUAL_IDLE_MS') || 900_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 900_000;
}

/** Setzt `workersMin` eines Endpoints – best effort, Fehler sind nicht fatal. */
async function setWorkersMin(role: ResolvedGpuRole, workersMin: number, signal?: AbortSignal): Promise<boolean> {
  if (!role.endpointId || !apiKey()) return false;
  // INFRA-FEAT-001: Wecken (workersMin > 0) einer gesperrten Rolle ist verboten –
  // die Sperre sitzt hier zusätzlich zum Wake-Einstieg, damit kein Pfad daran
  // vorbeikommt. Schlafen (0) ist IMMER erlaubt: es senkt nur die Kosten.
  if (workersMin > 0 && !isRoleAllowed(role.role)) {
    aiLogger.info('fleet wake suppressed by ai mode', { role: role.role, block: roleBlockCode(role.role) });
    return false;
  }
  try {
    const resp = await fetch(`${restBase()}/endpoints/${encodeURIComponent(role.endpointId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workersMin }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      aiLogger.warn('fleet workersMin update rejected', { role: role.role, workersMin, status: resp.status });
      return false;
    }
    return true;
  } catch (error) {
    aiLogger.warn('fleet workersMin update failed', { role: role.role, workersMin, error: (error as Error).message });
    return false;
  }
}

/**
 * Waermt eine Rolle vor – je nach Bauart des Workers unterschiedlich.
 *
 * Der Brain laeuft seit 2026-09-10 auf dem **vorgefertigten** RunPod-vLLM-Worker
 * (`runpod/worker-vllm`, `Qwen/Qwen3-14B-AWQ` mit `QUANTIZATION=awq`). Der kennt
 * unser `{task, model, input}`-Protokoll NICHT – ein `warmup`-Job wuerde dort als
 * ungueltiger Request enden. Warmup heisst in diesem Fall: eine minimale
 * Completion, die vLLM zwingt, die Gewichte tatsaechlich in den VRAM zu laden.
 *
 * Ohne `RP_BRAIN_OPENAI_URL` (eigener Worker) bleibt es beim `warmup`-Task.
 */
async function warmupRole(role: ResolvedGpuRole, signal?: AbortSignal): Promise<WarmupResult> {
  if (role.role !== 'brain') return new RunPodProvider(role.role).warmup(signal);

  const openAiBase = (env('RP_BRAIN_OPENAI_URL') || env('RUNPOD_BRAIN_OPENAI_URL')).replace(/\/+$/, '');
  if (!openAiBase) return new RunPodProvider(role.role).warmup(signal);

  const models = new RunPodProvider(role.role).role?.preload ?? [];
  const started = Date.now();
  try {
    const resp = await fetch(`${openAiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env('RUNPOD_BRAIN_MODEL') || 'Qwen/Qwen3-14B-AWQ',
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 1,
        temperature: 0,
        // vLLM reicht das an das Qwen3-Chat-Template durch (kein <think>-Block) –
        // konsistent mit `LlmRouter.ts`. Ohne dieses Feld liefert der rohe
        // vLLM-OpenAI-Pfad Reasoning-Tokens trotz max_tokens:1 (live belegt
        // 2026-09-12: Antwort begann mit "<think>Okay, the user is asking…").
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: signal ?? AbortSignal.timeout(Number(env('RUNPOD_WARMUP_TIMEOUT_MS') || 900_000)),
    });
    if (!resp.ok) {
      return { role: 'brain', ok: false, models, message: `OpenAI-Warmup HTTP ${resp.status}` };
    }
    aiLogger.info('brain warmup via openai path', { durationMs: Date.now() - started });
    return { role: 'brain', ok: true, models };
  } catch (error) {
    return { role: 'brain', ok: false, models, message: (error as Error).message };
  }
}

/** Ein Rollen-Status im Wake-/Sleep-Lauf (ohne Endpoint-ID → nicht konfiguriert). */
function unconfiguredStatus(role: ResolvedGpuRole, error: string): FleetRoleStatus {
  return {
    role: role.role,
    endpointId: '',
    configured: false,
    workersMinSet: false,
    warmupMode: role.warmupMode,
    warmup: null,
    error,
  };
}

/**
 * Weckt eine einzelne Rolle: immer `workersMin=1`; zusätzlich ein Warmup-Job,
 * wenn der Worker unser Protokoll kennt (`warmupMode: 'task'`).
 */
async function wakeRole(role: ResolvedGpuRole, signal?: AbortSignal): Promise<FleetRoleStatus> {
  if (!role.endpointId) {
    return unconfiguredStatus(role, `Endpoint-ID fehlt (${role.endpointIdEnv})`);
  }
  const workersMinSet = await setWorkersMin(role, 1, signal);
  const warmup = role.warmupMode === 'task' ? await warmupRole(role, signal) : null;
  return {
    role: role.role,
    endpointId: role.endpointId,
    configured: true,
    workersMinSet,
    warmupMode: role.warmupMode,
    warmup,
  };
}

/** Eine Rolle ist bereit, wenn sie geweckt wurde – Task-Rollen zusätzlich per Warmup. */
function roleReady(status: FleetRoleStatus): boolean {
  if (status.skipped) return true;
  if (!status.configured) return true;
  if (status.warmupMode === 'endpoint') return status.workersMinSet;
  return status.warmup?.ok === true;
}

export interface WakeOptions {
  /** Rollen, die geweckt werden sollen (Default: alle immer-Rollen). */
  roles?: readonly GpuRoleId[];
  /** Anlass: Studiostart (`session`) oder Visual-Abruf (`visual-on-demand`). */
  purpose?: 'session' | 'visual-on-demand';
  signal?: AbortSignal;
}

/** Nimmt die alte Signatur (`wakeFleet(signal)`) und die neue (`wakeFleet(options)`) an. */
function normalizeWakeOptions(input?: AbortSignal | WakeOptions): WakeOptions {
  if (!input) return {};
  if (typeof (input as AbortSignal).aborted === 'boolean') return { signal: input as AbortSignal };
  return input as WakeOptions;
}

let inflightWake: Promise<FleetReport> | null = null;

/**
 * Weckt die Flotte: `workersMin=1` je Endpoint plus (bei Task-Rollen) einen
 * Warmup-Job pro Rolle. Parallel laufende Aufrufe teilen sich denselben Lauf.
 *
 * Ohne `roles` werden NUR die immer-Rollen geweckt (INFRA-FEAT-002). Visuals
 * kommen ausschließlich über `wakeRoleOnDemand()` bzw. einen expliziten
 * `roles`-Eintrag hoch – und nur im Modus `on-with-visuals`.
 */
export async function wakeFleet(input?: AbortSignal | WakeOptions): Promise<FleetReport> {
  if (inflightWake) return inflightWake;
  inflightWake = doWake(normalizeWakeOptions(input)).finally(() => {
    inflightWake = null;
  });
  return inflightWake;
}

/** Rollen, die ein Wake-Lauf ohne explizite Auswahl anfassen darf. */
function defaultWakeRoles(resolved: readonly ResolvedGpuRole[]): ResolvedGpuRole[] {
  return resolved.filter((role) => !isVisualRole(role.role));
}

/** Bericht, wenn AI-Modus oder Budget den Lauf verhindern (ohne Netzwerk). */
function blockedReport(
  resolved: readonly ResolvedGpuRole[],
  blocked: FleetBlockReason,
  reason: string,
  /** Rollen, die dieser Lauf angefasst hätte. */
  intended: readonly GpuRoleId[],
): FleetReport {
  return {
    action: 'wake',
    startedAt: Date.now(),
    durationMs: 0,
    ok: false,
    blocked,
    reason,
    roles: resolved.map((role) => {
      const inScope = intended.includes(role.role);
      return {
        role: role.role,
        endpointId: role.endpointId,
        configured: Boolean(role.endpointId),
        workersMinSet: false,
        warmupMode: role.warmupMode,
        warmup: null,
        skipped: true,
        error: inScope ? reason : 'nicht im Scope dieses Laufs',
      };
    }),
  };
}

async function doWake(options: WakeOptions): Promise<FleetReport> {
  const startedAt = Date.now();
  const resolved = resolveGpuRoles();
  const requested = options.roles && options.roles.length > 0
    ? resolved.filter((role) => options.roles!.includes(role.role))
    : defaultWakeRoles(resolved);
  const intended = requested.map((role) => role.role);

  if (!flagEnabled('AI_FLEET_WAKE')) {
    return {
      action: 'wake',
      startedAt,
      durationMs: 0,
      ok: true,
      blocked: null,
      roles: resolved.map((role) => unconfiguredStatus(role, 'AI_FLEET_WAKE disabled')),
    };
  }

  // INFRA-FEAT-001: Bei „AI aus“ startet nichts – kein PATCH, kein Warmup.
  if (isAiDisabled()) {
    const reason = 'AI ist ausgeschaltet (aiMONK = OFF) – kein RunPod-Start, nur Hetzner-Kosten.';
    aiLogger.info('fleet wake blocked: ai disabled', { roles: intended });
    return blockedReport(resolved, 'ai-off', reason, intended);
  }

  // INFRA-FEAT-002: Visual-Rollen nur bei Abruf und nur mit Visual-Freigabe.
  const blockedVisuals = requested.filter((role) => isVisualRole(role.role) && !isRoleAllowed(role.role));
  if (blockedVisuals.length > 0) {
    const names = blockedVisuals.map((role) => role.role).join(', ');
    const reason = `Visual-Rolle(n) ${names} im Modus "AI ohne Visualisierung" gesperrt `
      + '(Visuals nur bei aiMONK = PRO bzw. AI_MODE=on-with-visuals).';
    aiLogger.warn('fleet wake blocked: visuals disabled', { roles: blockedVisuals.map((r) => r.role) });
    return blockedReport(resolved, 'visuals-off', reason, intended);
  }

  const toWake = requested.filter((role) => isRoleAllowed(role.role));
  const toWakeRoles = toWake.map((role) => role.role);

  // INFRA-FEAT-003: Budget-Gate VOR dem ersten Netzwerkaufruf.
  try {
    assertFleetHourlyBudget(toWakeRoles, AI_HETZNER_EUR_PER_HOUR);
  } catch (error) {
    const reason = (error as Error).message;
    aiLogger.error('fleet wake blocked by hourly budget', {
      roles: toWakeRoles,
      estimatedEurPerHour: estimateFleetEurPerHour(toWakeRoles) + AI_HETZNER_EUR_PER_HOUR,
      error: reason,
    });
    return blockedReport(resolved, 'budget', reason, intended);
  }

  const woken = await Promise.all(toWake.map((role) => wakeRole(role, options.signal)));
  const wokenByRole = new Map(woken.map((status) => [status.role, status]));
  const roles = resolved.map((role): FleetRoleStatus => {
    const status = wokenByRole.get(role.role);
    if (status) return status;
    return {
      role: role.role,
      endpointId: role.endpointId,
      configured: Boolean(role.endpointId),
      workersMinSet: false,
      warmupMode: role.warmupMode,
      warmup: null,
      skipped: true,
      error: isVisualRole(role.role) ? 'Visual-Rolle: startet nur bei Abruf' : 'nicht im Scope dieses Laufs',
    };
  });

  const ok = roles.every(roleReady);
  const report: FleetReport = {
    action: 'wake',
    startedAt,
    durationMs: Date.now() - startedAt,
    ok,
    blocked: null,
    roles,
  };
  aiLogger.info('fleet wake finished', {
    ok,
    purpose: options.purpose ?? 'session',
    estimatedEurPerHour: estimateFleetEurPerHour(toWakeRoles) + AI_HETZNER_EUR_PER_HOUR,
    durationMs: report.durationMs,
    roles: roles.map((r) => `${r.role}:${r.skipped ? 'skipped' : roleReady(r) ? 'ready' : r.error ?? r.warmup?.message ?? 'pending'}`),
  });
  return report;
}

let visualSleepTimers = new Map<GpuRoleId, ReturnType<typeof setTimeout>>();

/**
 * Legt eine bei Abruf gestartete Visual-Rolle nach `AI_VISUAL_IDLE_MS` wieder
 * schlafen (`workersMin=0`). Das ist die zweite Hälfte der Visual-Regel aus der
 * Konstitution (§2: „fallen danach auf Null zurück“) – RunPods eigener
 * idleTimeout greift nicht, solange `workersMin=1` gesetzt ist.
 */
export function scheduleVisualIdleSleep(role: GpuRoleId, idleMs = visualIdleMs()): void {
  if (!isVisualRole(role)) return;
  const previous = visualSleepTimers.get(role);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    visualSleepTimers.delete(role);
    const resolved = resolveGpuRoles().find((r) => r.role === role);
    if (!resolved) return;
    void setWorkersMin(resolved, 0).then((done) => {
      aiLogger.info('visual role idle-sleep', { role, workersMinSet: done, idleMs });
    });
  }, Math.max(0, idleMs));
  // Node: der Timer darf einen Shutdown nicht aufhalten.
  (timer as { unref?: () => void }).unref?.();
  visualSleepTimers.set(role, timer);
}

/**
 * Weckt EINE Rolle bedarfsgesteuert (Visual-Abruf). Best effort: Fehler werden
 * als Status gemeldet, nie geworfen – der eigentliche Job folgt direkt danach
 * und würde bei kaltem Worker ohnehin nur länger warten.
 */
export async function wakeRoleOnDemand(role: GpuRoleId, signal?: AbortSignal): Promise<FleetRoleStatus | null> {
  const resolved = resolveGpuRoles().find((r) => r.role === role);
  if (!resolved) return null;
  if (!resolved.endpointId) return unconfiguredStatus(resolved, `Endpoint-ID fehlt (${resolved.endpointIdEnv})`);
  if (!isRoleAllowed(role)) {
    const code = roleBlockCode(role);
    aiLogger.info('on-demand wake suppressed', { role, block: code });
    return {
      role,
      endpointId: resolved.endpointId,
      configured: true,
      workersMinSet: false,
      warmupMode: resolved.warmupMode,
      warmup: null,
      skipped: true,
      error: code ?? 'blocked',
    };
  }
  const status = await wakeRole(resolved, signal);
  scheduleVisualIdleSleep(role);
  aiLogger.info('visual role started on demand', { role, workersMinSet: status.workersMinSet, idleMs: visualIdleMs() });
  return status;
}

/** Setzt die Flotte schlafen (`workersMin=0`) – nach Session-Ende/Idle-Timeout. */
export async function sleepFleet(signal?: AbortSignal): Promise<FleetReport> {
  const startedAt = Date.now();
  const resolved = resolveGpuRoles();

  if (!flagEnabled('AI_FLEET_SLEEP')) {
    return {
      action: 'sleep',
      startedAt,
      durationMs: 0,
      ok: true,
      blocked: null,
      roles: resolved.map((role) => unconfiguredStatus(role, 'AI_FLEET_SLEEP disabled')),
    };
  }

  // Ein Schlafenlegen ist IMMER erlaubt – auch bei „AI aus“: es senkt nur die
  // Kosten und räumt Rollen auf, die vor dem Umschalten geweckt wurden.
  const roles = await Promise.all(
    resolved.map(async (role): Promise<FleetRoleStatus> => {
      if (!role.endpointId) {
        return unconfiguredStatus(role, `Endpoint-ID fehlt (${role.endpointIdEnv})`);
      }
      const workersMinSet = await setWorkersMin(role, 0, signal);
      return {
        role: role.role,
        endpointId: role.endpointId,
        configured: true,
        workersMinSet,
        warmupMode: role.warmupMode,
        warmup: null,
      };
    }),
  );

  const up = roles.filter((r) => r.configured && !r.workersMinSet);
  const report: FleetReport = {
    action: 'sleep',
    startedAt,
    durationMs: Date.now() - startedAt,
    ok: up.length === 0,
    blocked: null,
    roles,
  };
  aiLogger.info('fleet sleep finished', {
    ok: report.ok,
    notSlept: up.map((r) => r.role),
  });
  return report;
}

/** Reiner Zustandsbericht (kein Netzwerkaufruf) – für API und MCP. */
export function fleetStatus(): Record<string, unknown> {
  const resolved = resolveGpuRoles();
  const roleIds = resolved.map((role) => role.role);
  const gate = aiGateStatus(roleIds);
  const allowed = resolved.filter((role) => isRoleAllowed(role.role)).map((role) => role.role);
  const budget = fleetBudgetReport(allowed, AI_HETZNER_EUR_PER_HOUR);
  return {
    enabled: flagEnabled('AI_FLEET_WAKE'),
    wakeEnabled: flagEnabled('AI_FLEET_WAKE'),
    sleepEnabled: flagEnabled('AI_FLEET_SLEEP'),
    credentialConfigured: Boolean(apiKey()),
    // INFRA-FEAT-001/002/003: Modus, erlaubte Rollen und Kostenrahmen im Status.
    aiMode: gate.mode,
    aiModeSource: gate.source,
    aiEnabled: gate.aiEnabled,
    visualsEnabled: gate.visualsEnabled,
    allowedRoles: gate.allowedRoles,
    blockedRoles: gate.blockedRoles,
    alwaysOnRoles: alwaysOnRoles(),
    visualIdleMs: visualIdleMs(),
    budget: {
      gpuEurPerHour: budget.gpuEurPerHour,
      hetznerEurPerHour: budget.hetznerEurPerHour,
      totalEurPerHour: budget.totalEurPerHour,
      maxEurPerHour: budget.hourly.limit,
      withinLimit: budget.hourly.withinLimit,
      violation: budget.hourly.violation,
      target: budget.target,
      storage: budget.storage,
    },
    roles: resolved.map((role) => ({
      role: role.role,
      label: role.label,
      endpointName: role.endpointName,
      endpointId: role.endpointId,
      configured: Boolean(role.endpointId),
      usingLegacyEndpoint: role.usingLegacyEndpoint,
      gpuPoolId: role.gpuPoolId,
      gpuCount: role.gpuCount,
      vramBudgetGb: role.vramBudgetGb,
      warmupMode: role.warmupMode,
      tasks: [...role.tasks],
      preload: [...role.preload],
      allowed: isRoleAllowed(role.role),
      blockCode: roleBlockCode(role.role),
      visual: isVisualRole(role.role),
    })),
  };
}

/** Rollen, die ein Session-Wake anfasst (immer-Rollen ohne Visuals). */
export function sessionWakeRoles(): GpuRoleId[] {
  return defaultWakeRoles(resolveGpuRoles()).map((role) => role.role);
}

/** Nur für Tests: In-Flight-Guard und Visual-Timer zurücksetzen. */
export function __resetFleetWakeState(): void {
  inflightWake = null;
  for (const timer of visualSleepTimers.values()) clearTimeout(timer);
  visualSleepTimers = new Map();
}
