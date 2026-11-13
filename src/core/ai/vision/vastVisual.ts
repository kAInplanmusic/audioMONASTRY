/**
 * audioMONASTRY · Bild/Video über die Vast-Flotte
 * ===============================================
 * Gleiche Aufruf-Form wie die früheren runpodVision/runpodVideo-Module
 * (`generateVisionImage(prompt, opts)`, `generateVideo(image, prompt, opts)`),
 * aber ohne eigenen Netzwerkpfad: Rollenwahl, Pod-Start, Warteschlange,
 * Breaker und AI-Gate liegen im ProviderRouter → VastProvider
 * (`image.generate` → imageHq, `video.generate` → videoReal; beide auf dem
 * `vis`-Pod, siehe podRouting).
 *
 * Stand Vast-Migration: podRouting ordnet imageHq/videoReal KEINEM Pod zu –
 * die Aufrufe enden dann sofort mit `NO_POD_FOR_ROLE` (HTTP 503 in aiRoutes),
 * ohne GPU-Request. Bis 285ef5c liefen die Visuals über RunPod Serverless.
 *
 * Fehler kommen als `AiProviderError` (Code wie `NO_POD_FOR_ROLE`,
 * `AI_VISUALS_OFF`, `TIMEOUT`); fehlt das Bild/Video in der Worker-Ausgabe,
 * lautet der Code `NO_IMAGE` bzw. `NO_VIDEO`.
 */
import type { GpuEndpointRole } from '../../../config/aiInfrastructure';
import { AiGateError, assertRoleAllowed } from '../aiGate';
import { podRoleFor } from '../orchestrator/podRouting';
import { ProviderRouter } from '../orchestrator/providerRouter';
import { AiProviderError, type AiProviderId } from '../orchestrator/types';
import { extractVideo, extractVisionImage, stripDataUri } from './visualOutput';

export interface VisionImageResult {
  /** data-URI (`data:image/png;base64,...`) oder Bild-URL. */
  image: string;
  prompt: string;
  seed?: number;
  durationMs: number;
}

export interface VisionOptions {
  steps?: number;
  width?: number;
  height?: number;
  seed?: number;
}

export interface VideoResult {
  /** data-URI (`data:video/mp4;base64,...`), rohes base64 oder URL. */
  video: string;
  prompt: string;
  durationMs: number;
}

export interface VideoOptions {
  steps?: number;
  width?: number;
  height?: number;
  seed?: number;
  cfg?: number;
  negativePrompt?: string;
}

/** Bildmodell (FLUX.1-dev) und Videomodell (Wan2.2) der Visual-Rollen. */
export const VISION_IMAGE_MODEL = 'flux-dev';
export const VISION_VIDEO_MODEL = 'wan2.2';

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

/**
 * INFRA-FEAT-001/002: Bei „AI aus“ bzw. im Modus „ohne Visuals“ entsteht kein
 * einziger GPU-Request, und der Aufrufer bekommt den Sperr-Code
 * (`AI_DISABLED`/`AI_VISUALS_OFF`) statt eines allgemeinen NO_PROVIDER.
 */
function assertVisualAllowed(role: 'imageHq' | 'videoReal', provider: AiProviderId): void {
  try {
    assertRoleAllowed(role satisfies GpuEndpointRole, 'vision');
  } catch (error) {
    if (error instanceof AiGateError) throw new AiProviderError(provider, error.code, error.message, false);
    throw error;
  }
  // Die Vast-Flotte (podRouting) hat derzeit keinen Pod für die Visual-Rollen.
  // Ohne diese Prüfung meldete der Router nur ein allgemeines NO_PROVIDER.
  if (!podRoleFor(role)) {
    throw new AiProviderError(provider, 'NO_POD_FOR_ROLE', `Keine Visual-Generierung: kein Vast-Pod für ${role}`, false);
  }
}

let sharedRouter: ProviderRouter | null = null;
/** Lazy: der Router prüft beim Bau das Endpoint-Budget – nicht beim Import. */
function router(): ProviderRouter {
  sharedRouter ??= new ProviderRouter();
  return sharedRouter;
}

/** Erzeugt ein Bild (FLUX.1-dev) auf der imageHq-Rolle. */
export async function generateVisionImage(prompt: string, opts: VisionOptions = {}): Promise<VisionImageResult> {
  assertVisualAllowed('imageHq', 'vast-imageHq');
  const clean = String(prompt ?? '').trim().slice(0, 1200);
  if (!clean) throw new AiProviderError('vast-imageHq', 'NO_PROMPT', 'prompt fehlt', false);
  const started = Date.now();
  // worker-comfyui-Vertrag (imageHq, comfyui_adapter.build_single_image_request):
  // der Graph geht inline mit; auf dem Pod liegt kein workflows/imageHq.json.
  // Prompt/Seed/Größe stehen zusätzlich flach im Input, damit der Adapter sie
  // per Sampler-Verdrahtung einsetzt.
  const routed = await router().run('image.generate', VISION_IMAGE_MODEL, {
    prompt: clean,
    steps: opts.steps ?? 25,
    width: opts.width ?? 1024,
    height: opts.height ?? 1024,
    ...(typeof opts.seed === 'number' ? { seed: opts.seed } : {}),
    workflow: fluxVisionWorkflow({ prompt: clean, steps: opts.steps, width: opts.width, height: opts.height, seed: opts.seed }),
  });
  const image = extractVisionImage(routed.result);
  if (!image) throw new AiProviderError(routed.provider, 'NO_IMAGE', 'Worker lieferte kein Bild', false);
  const seed = (routed.result as { seed?: unknown } | null)?.seed;
  return {
    image,
    prompt: clean,
    seed: typeof seed === 'number' ? seed : undefined,
    durationMs: Date.now() - started,
  };
}

/** Erzeugt einen Clip aus einem Eingangsbild (Wan2.2 image→video) auf der videoReal-Rolle. */
export async function generateVideo(imageBase64: string, prompt: string, opts: VideoOptions = {}): Promise<VideoResult> {
  // Vertrag des Wan-Workers (comfyui_adapter.build_prompt_request): das Bild
  // kommt als `image_base64` OHNE data:-Präfix; ein Feld `image` würde der
  // Adapter verwerfen.
  assertVisualAllowed('videoReal', 'vast-videoReal');
  const image = stripDataUri(imageBase64);
  if (!image) throw new AiProviderError('vast-videoReal', 'NO_IMAGE', 'imageBase64 fehlt', false);
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

  const started = Date.now();
  const routed = await router().run('video.generate', VISION_VIDEO_MODEL, input);
  const raw = extractVideo(routed.result);
  if (!raw) throw new AiProviderError(routed.provider, 'NO_VIDEO', 'Worker lieferte kein Video', false);
  const video = raw.startsWith('data:video') || /^https?:\/\//.test(raw) ? raw : `data:video/mp4;base64,${raw}`;
  return { video, prompt: clean, durationMs: Date.now() - started };
}
