/**
 * audioMONASTRY · Visual-Rollen – gemeinsamer RunPod-Job-Client
 * ============================================================
 * WARUM DIESES MODUL (INFRA-RUNPOD-007):
 *
 * Die drei Visual-Rollen (`imageHq`, `videoReal`, `videoAbstract`) laufen auf
 * VORGEFERTIGTEN RunPod-Workern (ComfyUI-/Hub-Images; in endpointRegistry.ts
 * als `warmupMode: 'endpoint'` markiert). Diese Worker kennen unser
 * `{task, model, input}`-Protokoll NICHT – ein Umbiegen der Visual-Aufrufe auf
 * `RunPodProvider.run()` würde sie mit ungültigen Requests zerstören. Der
 * Sonderweg (eigene Payloads/Parser je Worker) bleibt deshalb bestehen
 * (Konstitution docs/INFRA_KONSTITUTION.md §1.1/§4).
 *
 * Was NICHT worker-spezifisch ist, liegt hier an EINER Stelle – vorher war es
 * in `runpodVision.ts`/`runpodVideo.ts` doppelt und uneinheitlich:
 *
 *   1. AI-Betriebsmodus (aiGate) VOR jedem Netzwerkaufruf (`assertVisualRoleAllowed`)
 *   2. Retry mit Backoff NUR bei wiederholbaren Fehlern (429/5xx/Netzfehler)
 *   3. Deadline/Zeitlimit über den GESAMTEN Job inkl. Kaltstart-Polling
 *   4. EIN Circuit Breaker je Rolle (Diagnose: `visionBreakerStates()`)
 *   5. Dieselbe Fehlercode-Familie wie der Rest der Flotte
 *
 * Die Fehlerklassen bleiben trotzdem bei den Aufrufern: `aiRoutes.ts` bildet
 * `VisionError`/`VideoError` samt `code` auf HTTP-Status ab (503/504/502). Der
 * Client erzeugt seine Fehler deshalb über eine injizierte Fabrik
 * (`makeError`) und kennt die konkrete Klasse nicht.
 */
import { envString, type GpuEndpointRole } from '../../../config/aiInfrastructure';
import { blockMessage, roleBlockCode } from '../aiGate';
import { aiLogger } from '../orchestrator/aiLogger';
import { CircuitBreaker, type BreakerState } from '../orchestrator/circuitBreaker';

/** RunPod-Serverless-API-Basis (per RUNPOD_API_BASE überschreibbar, z. B. Tests). */
export const DEFAULT_API_BASE = 'https://api.runpod.ai/v2';

/** Terminale Job-Zustände von RunPod – alles andere wird weiter gepollt. */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'ERROR']);

/** Botschafts-Präfixe, mit denen `CircuitBreaker` seine Ablehnung meldet. */
const BREAKER_OPEN_PREFIX = 'circuit breaker open: ';
const BREAKER_BUSY_PREFIX = 'circuit breaker half-open probe busy: ';

/** Fabrik für die Fehlerklasse des Aufrufers (VisionError/VideoError). */
export type JobErrorFactory = (code: string, message: string) => Error;

export interface VisualJobRequest {
  /** Visual-Rolle (bestimmt den Circuit Breaker und den Gate-Code). */
  role: GpuEndpointRole;
  endpointId: string;
  apiKey: string;
  /** Worker-spezifische Nutzlast (z. B. FLUX-Prompt bzw. Wan-Bild+Prompt). */
  input: Record<string, unknown>;
  /** Kurze Jobs über `/runsync`, lange über `/run` + Status-Polling. */
  submitPath: 'run' | 'runsync';
  /** Gesamtbudget inkl. Kaltstart (der Client bricht danach hart ab). */
  timeoutMs: number;
  makeError: JobErrorFactory;
  /** Label für Timeout-/Fehlermeldungen (z. B. 'Vision-Job'). */
  jobLabel?: string;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Nur für Tests: Warten (Backoff/Polling) ersetzen. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Nur für Tests: Basis-Backoff in ms (Default 1000, verdoppelt sich). */
  retryBaseMs?: number;
  /** Versuche je HTTP-Aufruf (Default 3, wie RunPodProvider). */
  maxAttempts?: number;
  /** Nur für Tests: Schwellen des rollen-eigenen Circuit Breakers. */
  breakerOptions?: { failureThreshold?: number; resetTimeoutMs?: number };
}

/**
 * Transport-Fehler des Clients. Kennzeichnet, ob ein erneuter Versuch sinnvoll
 * ist (429/5xx/Netz) – Fehler, die schon `makeError` erzeugt hat, werden NICHT
 * wiederholt (z. B. 400 vom Worker).
 */
class JobTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'JobTransportError';
  }
}

// ---------------------------------------------------------------------------
// Circuit Breaker je Rolle (geteilt über alle Aufrufe des Prozesses)
// ---------------------------------------------------------------------------
const breakers = new Map<string, CircuitBreaker>();

function breakerFor(
  role: GpuEndpointRole,
  options?: VisualJobRequest['breakerOptions'],
): CircuitBreaker {
  const existing = breakers.get(role);
  if (existing) return existing;
  const created = new CircuitBreaker(`runpod-visual-${role}`, options);
  breakers.set(role, created);
  return created;
}

/**
 * Zustand aller rollen-eigenen Breaker (Diagnose/Statusbericht, kein Netzwerk).
 * Über `fleetStatus()` und `/api/ai/fleet/status` sichtbar.
 */
export function visionBreakerStates(): Record<string, BreakerState> {
  const states: Record<string, BreakerState> = {};
  for (const [role, breaker] of breakers) states[role] = breaker.getState();
  return states;
}

/** Nur für Tests: Breaker-Zustände zurücksetzen (frische Schwellen/Zustände). */
export function __resetVisionBreakers(): void {
  breakers.clear();
}

function isBreakerRejection(error: unknown): boolean {
  const message = (error as Error)?.message ?? '';
  return message.startsWith(BREAKER_OPEN_PREFIX) || message.startsWith(BREAKER_BUSY_PREFIX);
}

// ---------------------------------------------------------------------------
// AI-Betriebsmodus (die Kante, die jeder RunPod-Aufruf passieren muss)
// ---------------------------------------------------------------------------

/**
 * Prüft den Betriebsmodus für eine Visual-Rolle und wirft über die Fehlerfabrik
 * des Aufrufers (`AI_DISABLED`/`AI_VISUALS_OFF`). Bei gesperrter Rolle entsteht
 * garantiert KEIN Netzwerkverkehr.
 */
export function assertVisualRoleAllowed(role: GpuEndpointRole, makeError: JobErrorFactory): void {
  const blocked = roleBlockCode(role);
  if (blocked) throw makeError(blocked, blockMessage(blocked, role, 'vision'));
}

// ---------------------------------------------------------------------------
// HTTP-Bausteine
// ---------------------------------------------------------------------------
function apiBase(): string {
  return envString('RUNPOD_API_BASE', DEFAULT_API_BASE).replace(/\/+$/, '');
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'audiomonastry-agent',
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(job: Record<string, unknown>): string {
  return String(job.status ?? '').toUpperCase();
}

/** true, wenn ein HTTP-Status einen erneuten Versuch rechtfertigt (429/5xx). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function runVisualJob(request: VisualJobRequest): Promise<Record<string, unknown>> {
  const {
    role, endpointId, apiKey, input, submitPath, timeoutMs, makeError,
  } = request;

  // 1) Betriebsmodus: gesperrte Rolle erzeugt keinen Netzwerkverkehr.
  assertVisualRoleAllowed(role, makeError);
  // 2) Kante konfiguriert? (Codes bleiben `NO_ENDPOINT`/`NO_KEY` wie bisher.)
  if (!endpointId) throw makeError('NO_ENDPOINT', `Endpoint-ID fuer Rolle ${role} ist nicht gesetzt`);
  if (!apiKey) throw makeError('NO_KEY', 'RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY ist nicht gesetzt');

  const doFetch = request.fetchImpl ?? fetch;
  const sleep = request.sleepImpl ?? defaultSleep;
  const jobLabel = request.jobLabel ?? 'RunPod-Job';
  const pollIntervalMs = Math.max(0, request.pollIntervalMs ?? 5_000);
  const retryBaseMs = Math.max(0, request.retryBaseMs ?? 1_000);
  const maxAttempts = Math.max(1, request.maxAttempts ?? 3);
  const deadline = Date.now() + timeoutMs;
  const base = `${apiBase()}/${encodeURIComponent(endpointId)}`;

  /**
   * Ein HTTP-Aufruf mit Backoff-Retry. Wiederholt wird NUR, was wiederholbar
   * ist (429/5xx/Netzfehler) – und nie über die Deadline hinaus.
   */
  const httpCall = async (
    url: string,
    init: RequestInit,
    what: string,
  ): Promise<Record<string, unknown>> => {
    let lastError = new JobTransportError('NETWORK', `${what} fehlgeschlagen`, true);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (request.signal?.aborted) throw makeError('CANCELLED', 'request cancelled');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw makeError('TIMEOUT', `${jobLabel} nach ${timeoutMs} ms nicht fertig`);
      try {
        const resp = await doFetch(url, {
          ...init,
          signal: request.signal ?? AbortSignal.timeout(Math.max(1_000, remaining)),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          const suffix = text ? `: ${text.slice(0, 200)}` : '';
          throw new JobTransportError('HTTP', `${what} HTTP ${resp.status}${suffix}`, isRetryableStatus(resp.status));
        }
        return (await resp.json()) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof JobTransportError) {
          lastError = error;
          if (!error.retryable) throw makeError(error.code, error.message);
        } else if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
          // Zeitlimit/Abbruch: kein Retry – die Deadline ist gerissen oder der
          // Aufrufer hat abgebrochen.
          throw makeError('TIMEOUT', `${what} Zeitlimit erreicht`);
        } else {
          lastError = new JobTransportError('NETWORK', `${what} fehlgeschlagen: ${(error as Error).message}`, true);
        }
        if (attempt < maxAttempts - 1) {
          aiLogger.warn('visual job retry', {
            role, attempt: attempt + 1, code: lastError.code, error: lastError.message.slice(0, 200),
          });
          await sleep(retryBaseMs * 2 ** attempt);
        }
      }
    }
    throw makeError(lastError.code, lastError.message);
  };

  const run = async (): Promise<Record<string, unknown>> => {
    let job = await httpCall(
      `${base}/${submitPath}`,
      { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify({ input }) },
      `${submitPath === 'run' ? 'run' : 'runsync'}`,
    );

    let status = statusOf(job);
    while (!TERMINAL_STATUSES.has(status)) {
      const jobId = String(job.id ?? '');
      // Ein nicht-terminaler Job OHNE ID kann nicht weiterverfolgt werden.
      if (!jobId) throw makeError('NO_JOB', 'Worker lieferte keine Job-ID');
      if (Date.now() >= deadline) {
        throw makeError('TIMEOUT', `${jobLabel} ${jobId} nach ${timeoutMs} ms nicht fertig`);
      }
      await sleep(pollIntervalMs);
      job = await httpCall(
        `${base}/status/${encodeURIComponent(jobId)}`,
        { headers: authHeaders(apiKey) },
        `status ${jobId}`,
      );
      status = statusOf(job);
    }
    return job;
  };

  // 3) Circuit Breaker je Rolle: ein offener Breaker lehnt sofort ab (fail-fast).
  //    Der Job (Submit + Polling) zählt als EIN Ergebnis – ein Endpoint, der
  //    reihenweise Zeitlimits reißt, öffnet den Breaker damit genauso wie ein
  //    5xx-Sturm beim Submit.
  const breaker = breakerFor(role, request.breakerOptions);
  try {
    return await breaker.call(run);
  } catch (error) {
    if (isBreakerRejection(error)) {
      aiLogger.warn('visual job rejected by circuit breaker', { role, state: breaker.getState() });
      throw makeError(
        'CIRCUIT_OPEN',
        `Circuit Breaker offen fuer Rolle ${role} – letzte Aufrufe sind wiederholt gescheitert `
          + `(Status: ${breaker.getState()})`,
      );
    }
    throw error;
  }
}
