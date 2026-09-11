/**
 * audioMONASTRY · VisualMONK – Text→Clip-Kette (FLUX-Bild → Wan2.2-Clip)
 * ====================================================================
 * Der Video-Worker der Flotte ist ein **image→video**-Worker (Wan2.2): er
 * bekommt ein Bild und erzeugt daraus Bewegung. „Text→Video“ ist deshalb eine
 * Kette aus zwei Rollen:
 *
 *   `vision` (FLUX.1-dev)  ──Bild──▶  `video` (Wan2.2)  ──▶  mp4
 *
 * Diese Datei kapselt die Kette **ohne Netzwerkfestlegung**: die beiden
 * Aufrufe sind injizierbar, damit die Verdrahtung (Prompt-Reihenfolge, Abbruch
 * ohne Bild, Fehlercodes) ohne RunPod testbar ist.
 */

import { buildMotionPrompt, buildVisionPrompt, type VisionStyle } from './visionPrompt';
import { generateVideo } from './runpodVideo';
import { generateVisionImage } from './runpodVision';

export class ClipPipelineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClipPipelineError';
    this.code = code;
  }
}

export interface ClipPipelineInput {
  text?: string;
  style?: VisionStyle;
  bpm?: number;
  /** Energie 0..1 aus dem Feature-Bus. */
  energy?: number;
  moodTags?: readonly string[];
  /** Zusätzlicher Bewegungs-Hinweis (sonst dient `text` als Hinweis). */
  motion?: string;
  imageSteps?: number;
  videoSteps?: number;
  /** Bildmaße (FLUX, Default 1024×1024). */
  width?: number;
  height?: number;
  /** Clipmaße (Wan2.2, Worker-Default 480×832). */
  videoWidth?: number;
  videoHeight?: number;
  seed?: number;
  negativePrompt?: string;
}

/** Die beiden austauschbaren Rollen-Aufrufe. */
export interface ClipPipelineDeps {
  image: typeof generateVisionImage;
  video: typeof generateVideo;
}

const DEFAULT_CLIP_DEPS: ClipPipelineDeps = {
  image: generateVisionImage,
  video: generateVideo,
};

export interface ClipPipelineResult {
  /** Prompt, mit dem das Bild erzeugt wurde. */
  imagePrompt: string;
  /** Prompt, mit dem die Bewegung erzeugt wurde. */
  motionPrompt: string;
  image: string;
  /** data-URI (`data:video/mp4;base64,…`). */
  video: string;
  seed?: number;
  imageMs: number;
  videoMs: number;
  durationMs: number;
}

/**
 * Erzeugt aus einem Text einen Clip: erst FLUX-Bild, dann Wan2.2-Bewegung.
 * Ohne Bild wird **abgebrochen** (kein stiller Weiterlauf in den Video-Worker).
 */
export async function generateClipFromPrompt(
  input: ClipPipelineInput,
  deps: ClipPipelineDeps = DEFAULT_CLIP_DEPS,
): Promise<ClipPipelineResult> {
  const imagePrompt = buildVisionPrompt({
    text: input.text,
    style: input.style,
    bpm: input.bpm,
    energy: input.energy,
    moodTags: input.moodTags,
  });
  const motionPrompt = buildMotionPrompt({
    text: input.motion?.trim() || input.text,
    style: input.style,
    bpm: input.bpm,
    energy: input.energy,
  });

  const started = Date.now();
  const img = await deps.image(imagePrompt, {
    steps: input.imageSteps ?? 25,
    width: input.width ?? 1024,
    height: input.height ?? 1024,
  });
  const image = String(img?.image ?? '');
  if (!image) throw new ClipPipelineError('NO_IMAGE', 'FLUX lieferte kein Bild – Clip abgebrochen');

  const vid = await deps.video(image, motionPrompt, {
    steps: input.videoSteps ?? 6,
    width: input.videoWidth,
    height: input.videoHeight,
    seed: input.seed,
    negativePrompt: input.negativePrompt,
  });
  const video = String(vid?.video ?? '');
  if (!video) throw new ClipPipelineError('NO_VIDEO', 'Video-Worker lieferte keinen Clip');

  return {
    imagePrompt,
    motionPrompt,
    image,
    video,
    seed: img.seed,
    imageMs: img.durationMs,
    videoMs: vid.durationMs,
    durationMs: Date.now() - started,
  };
}

/**
 * Erfahrungswerte für die UI (2026-09-11 live gemessen): Bild kalt ~40 s,
 * Clip kalt ~200 s. Bewusst grob – die Anzeige soll nur „es dauert“ ehrlich
 * benennen, nicht sekundengenau sein.
 */
export const CLIP_ETA_COLD_MS = 240_000;
const CLIP_ETA_WARM_MS = 70_000;

export function clipEtaMs(warm = false): number {
  return warm ? CLIP_ETA_WARM_MS : CLIP_ETA_COLD_MS;
}

export function formatEtaMs(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}
