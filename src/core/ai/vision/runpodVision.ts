/**
 * audioMONASTRY · VisualMONK – RunPod-Vision-Client (FLUX)
 * ========================================================
 * Ruft den Serverless-Endpoint der Rolle `imageHq` auf (FLUX.1-dev) und liefert
 * das erzeugte Bild als data-URI (oder URL). Der Worker-Input ist
 * `{ input: { prompt, num_inference_steps, width, height } }`, der Output traegt
 * `image_url` (data-URI) bzw. `images`.
 *
 * SONDERWEG (begruendet, INFRA-RUNPOD-007): Dieser Pfad geht NICHT durch den
 * `RunPodProvider`, weil der Worker ein VORGEFERTIGTES PrunaAI-FLUX-Image ist
 * (`warmupMode: 'endpoint'` in endpointRegistry.ts) und unser
 * `{task, model, input}`-Protokoll nicht kennt – ein Aufruf mit `task`-Feld
 * wuerde dort als ungueltiger Request enden. Alles, was NICHT worker-spezifisch
 * ist, teilt dieser Client mit den uebrigen Rollen ueber `runpodJobClient.ts`:
 * Gate, Retry mit Backoff, Deadline und ein Circuit Breaker je Rolle
 * (Konstitution docs/INFRA_KONSTITUTION.md §1.1/§4).
 *
 * Bewusst ohne feste Endpoint-ID im Code: die ID kommt aus der Flotten-Registry
 * (Rolle `imageHq`, Env `RP_ENDPOINT_ID_IMAGE`, Fallback `RP_ENDPOINT_ID`).
 */
import { resolveGpuRoles } from '../orchestrator/endpointRegistry';
import { wakeRoleOnDemand } from '../orchestrator/fleetWake';
import { assertVisualRoleAllowed, runVisualJob } from './runpodJobClient';

export interface VisionImageResult {
  /** data-URI (`data:image/png;base64,...`) oder Bild-URL. */
  image: string;
  prompt: string;
  seed?: number;
  durationMs: number;
}

export interface VisionOptions {
  endpointId?: string;
  apiKey?: string;
  steps?: number;
  width?: number;
  height?: number;
  /** Gesamtbudget inkl. Kaltstart (Default 15 min). */
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Nur für Tests: Warten (Backoff/Polling) ersetzen. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Nur für Tests: Basis-Backoff in ms (Default 1000). */
  retryBaseMs?: number;
}

export class VisionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
  }
}

function env(name: string): string {
  const v = (typeof process !== 'undefined' && process.env ? process.env[name] : undefined)?.trim();
  return v ?? '';
}

export function visionEndpointId(): string {
  // Einzige Quelle der Wahrheit ist die Flotten-Registry (Rolle `imageHq`).
  const resolved = resolveGpuRoles().find((r) => r.role === 'imageHq')?.endpointId;
  // Legacy-Fallback: der fruehere 4. Endpoint hiess `vision`.
  return resolved || env('RP_ENDPOINT_ID_VISION') || env('RUNPOD_ENDPOINT_ID_VISION');
}

/** Sucht rekursiv das erste Bild (data-URI oder URL) in der Worker-Ausgabe. */
export function extractVisionImage(output: unknown): string | null {
  if (typeof output === 'string') {
    if (output.startsWith('data:image')) return output;
    if (/^https?:\/\/.+\.(png|jpe?g|webp)(\?.*)?$/i.test(output)) return output;
    return null;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = extractVisionImage(item);
      if (found) return found;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    // Bevorzugt die bekannten FLUX-Felder, dann rekursiv.
    for (const key of ['image_url', 'image', 'url', 'images', 'output']) {
      if (key in rec) {
        const found = extractVisionImage(rec[key]);
        if (found) return found;
      }
    }
    for (const value of Object.values(rec)) {
      const found = extractVisionImage(value);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Erzeugt ein Bild. Nutzt `/runsync` und pollt bei kaltem Worker per
 * `/status/{id}` weiter (Kaltstart kann Minuten dauern).
 *
 * INFRA-RUNPOD-007: Netzwerk, Retry, Deadline und Circuit Breaker kommen aus
 * dem gemeinsamen `runpodJobClient` – dieser Pfad verhaelt sich damit wie jede
 * andere RunPod-Kante der Flotte.
 */
export async function generateVisionImage(prompt: string, opts: VisionOptions = {}): Promise<VisionImageResult> {
  // INFRA-FEAT-001/002: Der AI-Schalter gilt auch für den direkten Visual-Pfad.
  // Bei „AI aus“ bzw. Modus "ohne Visuals" entsteht hier KEIN Netzwerkverkehr.
  const visionError = (code: string, message: string): VisionError => new VisionError(code, message);
  assertVisualRoleAllowed('imageHq', visionError);
  const endpointId = opts.endpointId || visionEndpointId();
  const apiKey = opts.apiKey || env('RP_AGENT_KEY') || env('RP_API_KEY') || env('RUNPOD_API_KEY');
  const started = Date.now();

  if (!endpointId) throw visionError('NO_ENDPOINT', 'RP_ENDPOINT_ID_VISION ist nicht gesetzt');
  if (!apiKey) throw visionError('NO_KEY', 'RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY ist nicht gesetzt');
  const clean = String(prompt ?? '').trim().slice(0, 1200);
  if (!clean) throw visionError('NO_PROMPT', 'prompt fehlt');

  // INFRA-FEAT-002: Visual-Rolle erst JETZT starten (workersMin=1) und nach dem
  // Idle-Fenster automatisch schlafen legen. Best effort – der Job unten wartet
  // bei kaltem Worker ohnehin auf den Start; ein fehlgeschlagenes Wecken darf
  // die Generierung nicht verhindern.
  void wakeRoleOnDemand('imageHq');

  const job = await runVisualJob({
    role: 'imageHq',
    endpointId,
    apiKey,
    submitPath: 'runsync',
    jobLabel: 'Vision-Job',
    timeoutMs: opts.timeoutMs ?? 900_000,
    pollIntervalMs: opts.pollIntervalMs,
    fetchImpl: opts.fetchImpl,
    sleepImpl: opts.sleepImpl,
    retryBaseMs: opts.retryBaseMs,
    makeError: visionError,
    // Worker-eigener Vertrag: FLUX kennt kein {task, model}-Umschlagfeld.
    input: {
      prompt: clean,
      num_inference_steps: opts.steps ?? 25,
      width: opts.width ?? 1024,
      height: opts.height ?? 1024,
    },
  });

  const status = String(job.status ?? '').toUpperCase();
  if (status !== 'COMPLETED') throw visionError(status || 'FAILED', `Vision-Job ${status}`);

  const image = extractVisionImage(job.output);
  if (!image) throw visionError('NO_IMAGE', 'Worker lieferte kein Bild');
  const output = (job.output ?? {}) as Record<string, unknown>;
  const seed = typeof output.seed === 'number' ? output.seed : undefined;
  return { image, prompt: clean, seed, durationMs: Date.now() - started };
}
