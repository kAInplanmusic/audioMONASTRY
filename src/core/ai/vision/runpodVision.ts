/**
 * audioMONASTRY · VisualMONK – RunPod-Vision-Client (FLUX)
 * ========================================================
 * Ruft den Serverless-Endpoint der Rolle `imageHq` auf (FLUX.1-dev) und liefert
 * das erzeugte Bild als data-URI (oder URL).
 *
 * SEIT 2026-09-27 laeuft dieser Endpoint auf `runpod/worker-comfyui` statt auf
 * dem PrunaAI-FLUX-Image (Entscheidung „Weg A", visualplan.md §15/§16). Der
 * Input ist damit `{ input: { workflow } }` — der ComfyUI-Worker kennt **keinen**
 * `prompt`-Parameter, der Text steckt IM Graphen. Der Output ist
 * `{ images: [{ filename, type: 'base64', data: '<rohes base64>' }] }`.
 *
 * Warum der Graph hier im Code steht und nicht als Datei geladen wird: dieser
 * Pfad laeuft im Browser-/Node-Bundle der App und hat keinen Zugriff auf den
 * Serverless-Ordner. Die Struktur ist bewusst **dieselbe** wie in
 * `services/audiomonastry-ai-runtime/workflows/image_flux1.json`; die
 * SDXL/LoRA-Fassung fuer den Adapter-Pfad liegt dort als Datei.
 *
 * SONDERWEG (begruendet, INFRA-RUNPOD-007): Dieser Pfad geht NICHT durch den
 * `RunPodProvider`, weil der Worker ein VORGEFERTIGTES Image ist
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

/**
 * Der FLUX.1-dev-Graph fuer den ComfyUI-Worker.
 *
 * Gleiche Struktur wie `services/audiomonastry-ai-runtime/workflows/image_flux1.json`
 * (dort als Datei, hier im Code, weil dieser Pfad im App-Bundle laeuft).
 * CFG 1.0 ist bei FLUX.1-dev richtig — der Negative-Knoten bleibt verdrahtet,
 * wirkt aber nicht; ComfyUI verlangt den Eingang.
 */
export function fluxVisionWorkflow(opts: {
  prompt: string;
  steps?: number;
  width?: number;
  height?: number;
  seed?: number;
}): Record<string, unknown> {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev-fp8.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: opts.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': {
      class_type: 'EmptyLatentImage',
      inputs: { width: opts.width ?? 1024, height: opts.height ?? 1024, batch_size: 1 },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: opts.seed ?? 0,
        steps: opts.steps ?? 25,
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1.0,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'vision', images: ['6', 0] } },
  };
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
    // worker-comfyui (ab 5.x): { filename, type: 'base64', data: '<rohes base64>' }.
    // Das rohe base64 traegt kein "data:"-Praefix und wuerde unten durchfallen —
    // ohne diese Zeilen liefert der neue Worker scheinbar "kein Bild".
    if (typeof rec.data === 'string' && rec.data) {
      if (rec.type === 's3') return rec.data;
      return rec.data.startsWith('data:') ? rec.data : `data:image/png;base64,${rec.data}`;
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
    // Worker-eigener Vertrag (worker-comfyui): der Prompt steckt IM Graphen.
    // Ein `prompt`-Feld wuerde der Worker ignorieren und immer das im Workflow
    // hinterlegte Demo-Bild liefern — ein stiller Fehlschlag.
    input: {
      workflow: fluxVisionWorkflow({
        prompt: clean,
        steps: opts.steps,
        width: opts.width,
        height: opts.height,
      }),
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
