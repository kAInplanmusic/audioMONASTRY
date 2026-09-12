/**
 * audioMONASTRY · AI-Orchestrator – Session-Wake der GPU-Flotte
 * =============================================================
 * Die drei Serverless-Endpoints (brain / ears / voiceGen) skalieren auf 0,
 * damit im Idle keine GPU-Kosten entstehen. Der Preis dafür ist ein Kaltstart
 * beim ersten Task eines Tages. Da die App selbst 5–10 min zum Hochfahren
 * braucht, wird der Kaltstart versteckt:
 *
 *   1. `wakeFleet()` setzt `workersMin` je Endpoint temporär auf 1 (best effort,
 *      RunPod REST) und feuert pro Rolle einen `warmup`-Job, der die
 *      Preload-Modelle des Rollen-Manifests in VRAM lädt.
 *   2. Ist die Flotte warm, treffen echte Tasks keine Modell-Ladezeit mehr.
 *   3. `sleepFleet()` setzt `workersMin` zurück auf 0 – aufgerufen beim
 *      Session-Ende bzw. Idle-Timeout (SessionManager.onScaleToZero).
 *
 * Konfiguration:
 *   RUNPOD_ENDPOINT_ID_BRAIN / _EARS / _VOICE   (Fallback: RUNPOD_ENDPOINT_ID)
 *   RUNPOD_API_KEY | RP_API_KEY
 *   RUNPOD_REST_BASE      (Default https://rest.runpod.io/v1)
 *   AI_FLEET_WAKE=0       deaktiviert das Aufwecken (kein Netzwerkverkehr)
 *   AI_FLEET_SLEEP=0      deaktiviert das Zurücksetzen
 */
import type { GpuRoleId } from '../../../config/aiInfrastructure';
import { aiLogger } from './aiLogger';
import { resolveGpuRoles, type ResolvedGpuRole } from './endpointRegistry';
import { RunPodProvider, type WarmupResult } from './runpodProvider';

const DEFAULT_REST_BASE = 'https://rest.runpod.io/v1';

/** Status einer Rolle nach einem Wake-/Sleep-Lauf. */
interface FleetRoleStatus {
  role: GpuRoleId;
  endpointId: string;
  configured: boolean;
  /** Konnte `workersMin` gesetzt werden? (best effort) */
  workersMinSet: boolean;
  warmup: WarmupResult | null;
  error?: string;
}

/** Ergebnis eines Flotten-Laufs. */
export interface FleetReport {
  action: 'wake' | 'sleep';
  startedAt: number;
  durationMs: number;
  ok: boolean;
  roles: FleetRoleStatus[];
  /** Rolle `vision` (FLUX) – kennt keinen `warmup`-Task, wird nur per workersMin geweckt. */
  vision?: { endpointId: string; workersMinSet: boolean } | null;
  /** Rolle `video` (Wan2.2) – ebenfalls nur per workersMin. */
  video?: { endpointId: string; workersMinSet: boolean } | null;
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function restBase(): string {
  return (env('RUNPOD_REST_BASE') || DEFAULT_REST_BASE).replace(/\/+$/, '');
}

function apiKey(): string {
  return env('RUNPOD_API_KEY') || env('RP_API_KEY');
}

function flagEnabled(name: string): boolean {
  const raw = env(name);
  if (!raw) return true;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

/** Setzt `workersMin` eines Endpoints – best effort, Fehler sind nicht fatal. */
async function setWorkersMin(role: ResolvedGpuRole, workersMin: number, signal?: AbortSignal): Promise<boolean> {
  if (!role.endpointId || !apiKey()) return false;
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
 * Ohne `RUNPOD_BRAIN_OPENAI_URL` (eigener Worker) bleibt es beim `warmup`-Task.
 */
async function warmupRole(role: ResolvedGpuRole, signal?: AbortSignal): Promise<WarmupResult> {
  if (role.role !== 'brain') return new RunPodProvider(role.role).warmup(signal);

  const openAiBase = env('RUNPOD_BRAIN_OPENAI_URL').replace(/\/+$/, '');
  if (!openAiBase) return new RunPodProvider(role.role).warmup(signal);

  const models = new RunPodProvider(role.role).role?.preload ?? [];
  const started = Date.now();
  try {
    const resp = await fetch(`${openAiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env('RUNPOD_API_KEY') || env('RP_API_KEY')}`,
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

/** Best effort: beliebigen Endpoint per REST auf `workersMin` setzen (z. B. Rolle vision). */
async function setEndpointWorkersMin(endpointId: string, workersMin: number, signal?: AbortSignal): Promise<boolean> {
  if (!endpointId || !apiKey()) return false;
  try {
    const resp = await fetch(`${restBase()}/endpoints/${encodeURIComponent(endpointId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workersMin }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    return resp.ok;
  } catch (error) {
    aiLogger.warn('vision workersMin update failed', { workersMin, error: (error as Error).message });
    return false;
  }
}

/**
 * Rolle `vision` (FLUX-Worker) wecken/schlafen: sie kennt keinen `warmup`-Task,
 * Wecken ist hier `workersMin=1` (der Worker zieht Image + Gewichte).
 */
async function toggleVision(workersMin: number, signal?: AbortSignal): Promise<{ endpointId: string; workersMinSet: boolean } | null> {
  const endpointId = env('RUNPOD_ENDPOINT_ID_VISION');
  if (!endpointId) return null;
  return { endpointId, workersMinSet: await setEndpointWorkersMin(endpointId, workersMin, signal) };
}

async function toggleVideo(workersMin: number, signal?: AbortSignal): Promise<{ endpointId: string; workersMinSet: boolean } | null> {
  const endpointId = env('RUNPOD_ENDPOINT_ID_VIDEO');
  if (!endpointId) return null;
  return { endpointId, workersMinSet: await setEndpointWorkersMin(endpointId, workersMin, signal) };
}

let inflightWake: Promise<FleetReport> | null = null;

/**
 * Weckt die Flotte: `workersMin=1` je Endpoint plus ein Warmup-Job pro Rolle.
 * Parallel laufende Aufrufe teilen sich denselben Lauf.
 */
export async function wakeFleet(signal?: AbortSignal): Promise<FleetReport> {
  if (inflightWake) return inflightWake;
  inflightWake = doWake(signal).finally(() => {
    inflightWake = null;
  });
  return inflightWake;
}

async function doWake(signal?: AbortSignal): Promise<FleetReport> {
  const startedAt = Date.now();
  const resolved = resolveGpuRoles();

  if (!flagEnabled('AI_FLEET_WAKE')) {
    return {
      action: 'wake',
      startedAt,
      durationMs: 0,
      ok: true,
      roles: resolved.map((role) => ({
        role: role.role,
        endpointId: role.endpointId,
        configured: Boolean(role.endpointId),
        workersMinSet: false,
        warmup: null,
        error: 'AI_FLEET_WAKE disabled',
      })),
    };
  }

  const roles = await Promise.all(
    resolved.map(async (role): Promise<FleetRoleStatus> => {
      if (!role.endpointId) {
        return {
          role: role.role,
          endpointId: '',
          configured: false,
          workersMinSet: false,
          warmup: null,
          error: `Endpoint-ID fehlt (${role.endpointIdEnv})`,
        };
      }
      const workersMinSet = await setWorkersMin(role, 1, signal);
      const warmup = await warmupRole(role, signal);
      return { role: role.role, endpointId: role.endpointId, configured: true, workersMinSet, warmup };
    }),
  );

  const ok = roles.every((r) => !r.configured || r.warmup?.ok === true);
  const vision = await toggleVision(1, signal);
  const video = await toggleVideo(1, signal);
  const report: FleetReport = { action: 'wake', startedAt, durationMs: Date.now() - startedAt, ok, roles, vision, video };
  aiLogger.info('fleet wake finished', {
    ok,
    durationMs: report.durationMs,
    roles: roles.map((r) => `${r.role}:${r.warmup?.ok ? 'ready' : r.error ?? 'pending'}`),
  });
  return report;
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
      roles: resolved.map((role) => ({
        role: role.role,
        endpointId: role.endpointId,
        configured: Boolean(role.endpointId),
        workersMinSet: false,
        warmup: null,
        error: 'AI_FLEET_SLEEP disabled',
      })),
    };
  }

  const roles = await Promise.all(
    resolved.map(async (role): Promise<FleetRoleStatus> => {
      if (!role.endpointId) {
        return {
          role: role.role,
          endpointId: '',
          configured: false,
          workersMinSet: false,
          warmup: null,
          error: `Endpoint-ID fehlt (${role.endpointIdEnv})`,
        };
      }
      const workersMinSet = await setWorkersMin(role, 0, signal);
      return { role: role.role, endpointId: role.endpointId, configured: true, workersMinSet, warmup: null };
    }),
  );

  const up = roles.filter((r) => r.configured && !r.workersMinSet);
  const vision = await toggleVision(0, signal);
  const video = await toggleVideo(0, signal);
  const report: FleetReport = {
    action: 'sleep',
    startedAt,
    durationMs: Date.now() - startedAt,
    ok: up.length === 0,
    roles,
    vision,
    video,
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
  return {
    enabled: flagEnabled('AI_FLEET_WAKE'),
    wakeEnabled: flagEnabled('AI_FLEET_WAKE'),
    sleepEnabled: flagEnabled('AI_FLEET_SLEEP'),
    credentialConfigured: Boolean(apiKey()),
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
      tasks: [...role.tasks],
      preload: [...role.preload],
    })),
  };
}

/** Nur für Tests: setzt den In-Flight-Guard zurück. */
export function __resetFleetWakeState(): void {
  inflightWake = null;
}
