/**
 * audioMONASTRY · VisualMONK – RunPod-Video-Client (Wan2.2 image->video)
 * =====================================================================
 * Ruft den Serverless-Endpoint der Rolle `videoReal` auf. Der Worker ist ein
 * ComfyUI/Wan2.2-Image-to-Video-Worker:
 *   Input:  { image_base64: <ROHES base64, KEIN data:-Praefix>, prompt, negative_prompt?, width?, height?, steps?, cfg?, seed? }
 *   Output: { video: <rohes base64 mp4> }
 * Ein `data:`-Praefix am Bild laesst den Worker mit "Incorrect padding"
 * scheitern (live verifiziert 2026-09-11) – deshalb wird hier immer der
 * reine Base64-Teil gesendet und das Ergebnis als data-URI zurueckgegeben.
 *
 * SONDERWEG (begruendet, INFRA-RUNPOD-007): Der Worker ist ein VORGEFERTIGTES
 * Wan2.2-ComfyUI-Image (`warmupMode: 'endpoint'` in endpointRegistry.ts) und
 * kennt unser `{task, model, input}`-Protokoll NICHT – ein Aufruf ueber den
 * `RunPodProvider` wuerde ihn mit ungueltigen Requests treffen. Alles, was
 * NICHT worker-spezifisch ist, kommt deshalb aus `runpodJobClient.ts`: Gate,
 * Retry mit Backoff, Deadline und ein Circuit Breaker je Rolle
 * (Konstitution docs/INFRA_KONSTITUTION.md §1.1/§4).
 *
 * Endpoint-ID aus der Flotten-Registry (Rolle `videoReal`, Env
 * `RP_ENDPOINT_ID_VIDEO_REAL`, Fallback `RP_ENDPOINT_ID`).
 */
import { resolveGpuRoles } from '../orchestrator/endpointRegistry';
import { wakeRoleOnDemand } from '../orchestrator/fleetWake';
import { assertVisualRoleAllowed, runVisualJob } from './runpodJobClient';

export interface VideoResult {
  /** data-URI (`data:video/mp4;base64,...`). */
  video: string;
  prompt: string;
  durationMs: number;
}

export interface VideoOptions {
  endpointId?: string;
  apiKey?: string;
  steps?: number;
  width?: number;
  height?: number;
  seed?: number;
  cfg?: number;
  negativePrompt?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Nur für Tests: Warten (Backoff/Polling) ersetzen. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Nur für Tests: Basis-Backoff in ms (Default 1000). */
  retryBaseMs?: number;
}

export class VideoError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VideoError';
    this.code = code;
  }
}

function env(name: string): string {
  const v = (typeof process !== 'undefined' && process.env ? process.env[name] : undefined)?.trim();
  return v ?? '';
}

export function videoEndpointId(): string {
  // Einzige Quelle der Wahrheit ist die Flotten-Registry (Rolle `videoReal`).
  const resolved = resolveGpuRoles().find((r) => r.role === 'videoReal')?.endpointId;
  // Legacy-Fallback: der fruehere 5. Endpoint hiess `video`.
  return resolved || env('RP_ENDPOINT_ID_VIDEO') || env('RUNPOD_ENDPOINT_ID_VIDEO');
}

/** Entfernt ein evtl. vorhandenes `data:…;base64,`-Praefix. */
export function stripDataUri(value: string): string {
  const s = String(value ?? '').trim();
  const comma = s.indexOf('base64,');
  return comma >= 0 ? s.slice(comma + 7).replace(/\s+/g, '') : s.replace(/\s+/g, '');
}

/** Zieht das Video (rohes base64 oder data-URI) aus der Worker-Ausgabe. */
export function extractVideo(output: unknown): string | null {
  if (typeof output === 'string') {
    if (output.startsWith('data:video')) return output;
    if (/^https?:\/\/.+\.(mp4|webm|mov)(\?.*)?$/i.test(output)) return output;
    if (output.length > 100) return output;
    return null;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = extractVideo(item);
      if (found) return found;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    for (const key of ['video', 'video_base64', 'output', 'videos', 'url', 'video_url']) {
      if (key in rec) {
        const found = extractVideo(rec[key]);
        if (found) return found;
      }
    }
    for (const value of Object.values(rec)) {
      const found = extractVideo(value);
      if (found) return found;
    }
  }
  return null;
}

/** Erzeugt einen Clip aus einem Eingangsbild (Wan2.2 image->video). */
export async function generateVideo(imageBase64: string, prompt: string, opts: VideoOptions = {}): Promise<VideoResult> {
  // INFRA-FEAT-001/002: Auch der Video-Pfad hängt am AI-Schalter – bei „AI aus“
  // bzw. Modus "ohne Visuals" entsteht hier kein einziger RunPod-Request.
  const videoError = (code: string, message: string): VideoError => new VideoError(code, message);
  assertVisualRoleAllowed('videoReal', videoError);
  const endpointId = opts.endpointId || videoEndpointId();
  const apiKey = opts.apiKey || env('RP_AGENT_KEY') || env('RP_API_KEY') || env('RUNPOD_API_KEY');
  const started = Date.now();

  if (!endpointId) throw videoError('NO_ENDPOINT', 'RP_ENDPOINT_ID_VIDEO ist nicht gesetzt');
  if (!apiKey) throw videoError('NO_KEY', 'RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY ist nicht gesetzt');
  const image = stripDataUri(imageBase64);
  if (!image) throw videoError('NO_IMAGE', 'imageBase64 fehlt');
  const clean = String(prompt ?? '').trim().slice(0, 1200) || 'gentle camera push in, subtle motion';

  const input: Record<string, unknown> = {
    image_base64: image,
    prompt: clean,
    steps: opts.steps ?? 6,
    width: opts.width ?? 480,
    height: opts.height ?? 832,
    cfg: opts.cfg ?? 2.0,
  };
  if (opts.negativePrompt) input.negative_prompt = opts.negativePrompt.slice(0, 500);
  if (typeof opts.seed === 'number') input.seed = opts.seed;

  // INFRA-FEAT-002: Video-Rolle erst bei Abruf starten und danach per Idle-Timer
  // wieder auf workersMin=0 setzen (best effort, siehe runpodVision.ts).
  void wakeRoleOnDemand('videoReal');

  const job = await runVisualJob({
    role: 'videoReal',
    endpointId,
    apiKey,
    // Video-Jobs sprengen das runsync-Fenster (Diffusion ueber viele Schritte).
    submitPath: 'run',
    jobLabel: 'Video-Job',
    timeoutMs: opts.timeoutMs ?? 1_800_000,
    pollIntervalMs: opts.pollIntervalMs,
    fetchImpl: opts.fetchImpl,
    sleepImpl: opts.sleepImpl,
    retryBaseMs: opts.retryBaseMs,
    makeError: videoError,
    // Worker-eigener Vertrag: Wan2.2 kennt kein {task, model}-Umschlagfeld.
    input,
  });

  const status = String(job.status ?? '').toUpperCase();
  if (status !== 'COMPLETED') {
    throw videoError(status || 'FAILED', String(job.error ?? `Video-Job ${status}`).slice(0, 300));
  }

  const raw = extractVideo(job.output);
  if (!raw) throw videoError('NO_VIDEO', 'Worker lieferte kein Video');
  const video = raw.startsWith('data:video') ? raw : `data:video/mp4;base64,${raw}`;
  return { video, prompt: clean, durationMs: Date.now() - started };
}
