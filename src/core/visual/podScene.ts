/**
 * audioMONASTRY · VisualMONK auf dem vis-Pod (headless Chromium)
 * ==============================================================
 * Dünner Einstieg, der DIESELBEN Bausteine wie die Overlay-Komponente fährt
 * (WebGL-Shader, Audio→Parameter-Abbildung, Show-Orchestrator mit Bildern und
 * Clips), damit der Look auf dem Pod und im Browser identisch bleibt. Er wird
 * mit `npm run build:vis-scene` zu `services/audiomonastry-ai-runtime/visual/scene.js`
 * gebündelt; der Pod steuert ihn über `window.__vis`.
 *
 * Takt: Der Aufrufer liefert den Frame-Index. Die Show-Uhr ist `index * 1000 / fps`
 * (nicht die Wanduhr), damit Szenenwechsel und Feldbewegung bildgenau und
 * reproduzierbar laufen. Clips (Videos) laufen von selbst in Echtzeit.
 *
 * Kein Netzwerk-, Speicher- oder Audiozugriff hier: Medien-URLs und Features
 * liefert der Pod; die Frames liefert `frame()` als JPEG-Data-URL im selben Task
 * (ein WebGL-Zeichenpuffer ist nach dem Task nicht mehr lesbar).
 */
import { blendParams, mapAudioToParams, normalizeFeatures } from './audioReactive';
import { presetById } from './visualPresets';
import {
  createShowState,
  showFade,
  tickShow,
  type ShowOptions,
  type ShowScene,
  type ShowState,
} from './showOrchestrator';
import { createDirector, directEffects, orderPicks, type DirectorState, type EffectPick } from './effects/registry';
import { createMediaFxRenderer, type MediaFxRenderer } from './mediaFx';
import { createWebGLVisualRenderer, type VisualSceneFrame, type WebGLVisualRenderer } from './webglRenderer';
import type { AudioFeatures, VisualParams } from './types';

export interface PodSceneConfig {
  width: number;
  height: number;
  fps: number;
  presetId?: string;
  seed?: number;
  scenes: ShowScene[];
  show?: ShowOptions;
  /** 'auto' (Regisseur wählt), 'off' oder feste Liste. Standard 'auto'. */
  effects?: EffectMode;
  /** Höchstzahl gleichzeitiger Effekte im Modus 'auto' (1..4, Standard 3). */
  maxEffects?: number;
}

export type EffectMode = 'auto' | 'off' | Array<{ id: string; amount?: number }>;

export interface PodFrameInfo {
  sceneIndex: number;
  fade: number;
  advanced: boolean;
  reason: string | null;
  skippedScenes: number;
  /** Aktive Effekt-IDs dieses Frames. */
  effects: string[];
}

export interface PodSceneApi {
  init(config: PodSceneConfig): Promise<{ renderer: string; loadedScenes: number; skippedScenes: number }>;
  frame(features: Partial<AudioFeatures>, index: number, jpegQuality?: number, profile?: boolean): { info: PodFrameInfo; jpeg: string | null; timing?: { renderMs: number; encodeMs: number } };
  /**
   * Messpfad: `count` Frames hintereinander rendern; die JPEG-Kodierung (toBlob) laeuft asynchron und
   * ueberlappt mit dem Rendern des Folgeframes. Liefert Base64-JPEGs und die Zeit je Teilschritt.
   */
  burst(features: Partial<AudioFeatures>, startIndex: number, count: number, jpegQuality?: number): Promise<{ jpegs: string[]; totalMs: number; renderMs: number }>;
  setEffects(mode: EffectMode, maxEffects?: number): void;
  /** Preset und Show-Optionen (Überblendung, Standzeit) live ändern. */
  setLook(look: { presetId?: string | null; show?: ShowOptions }): void;
  /** Effekt-IDs, die auf dieser GPU kompilieren. */
  compiledEffects(): string[];
  dispose(): void;
}

declare global {
  interface Window {
    __vis?: PodSceneApi;
  }
}

const MEDIA_TIMEOUT_MS = 20000;
const SMOOTHING = 0.35;

type Media = HTMLImageElement | HTMLVideoElement;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => reject(new Error('image timeout')), MEDIA_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('image error')); };
    img.src = src;
  });
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    const timer = setTimeout(() => reject(new Error('video timeout')), MEDIA_TIMEOUT_MS);
    video.onloadeddata = () => {
      clearTimeout(timer);
      void video.play().catch(() => undefined);
      resolve(video);
    };
    video.onerror = () => { clearTimeout(timer); reject(new Error('video error')); };
    video.src = src;
  });
}

let canvas: HTMLCanvasElement | null = null;
let renderer: WebGLVisualRenderer | null = null;
let fx: MediaFxRenderer | null = null;
let cfg: PodSceneConfig | null = null;
let scenes: ShowScene[] = [];
let media: Media[] = [];
let state: ShowState | null = null;
let params: VisualParams | null = null;
let skipped = 0;
let effectMode: EffectMode = 'auto';
let maxEffects = 3;
let director: DirectorState = createDirector();

function rendererName(gl: WebGLRenderingContext | WebGL2RenderingContext | null): string {
  if (!gl) return 'none';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return String(name);
}

async function init(config: PodSceneConfig) {
  dispose();
  cfg = config;
  canvas = document.getElementById('stage') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('stage canvas missing');
  canvas.width = config.width;
  canvas.height = config.height;
  scenes = [];
  media = [];
  skipped = 0;
  for (const scene of config.scenes) {
    try {
      media.push(scene.kind === 'clip' ? await loadVideo(scene.src) : await loadImage(scene.src));
      scenes.push(scene);
    } catch {
      skipped += 1;
    }
  }
  // Mit Medien: Effektstufe auf Bild/Clip. Ohne Medien: das generative Feld des Shaders.
  if (scenes.length > 0) {
    fx = createMediaFxRenderer(canvas);
    if (!fx) throw new Error('WebGL unavailable');
    fx.resize(config.width, config.height);
  } else {
    renderer = createWebGLVisualRenderer(canvas);
    if (!renderer) throw new Error('WebGL unavailable');
    renderer.resize(config.width, config.height);
  }
  const probe = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  state = createShowState(0, 0, 0, config.seed ?? undefined);
  params = null;
  setEffects(config.effects ?? 'auto', config.maxEffects);
  return { renderer: `${(fx ?? renderer)!.kind}:${rendererName(probe)}`, loadedScenes: scenes.length, skippedScenes: skipped };
}

function setLook(look: { presetId?: string | null; show?: ShowOptions }) {
  if (!cfg) return;
  if (look.presetId !== undefined) cfg.presetId = look.presetId ?? undefined;
  if (look.show) cfg.show = { ...(cfg.show ?? {}), ...look.show };
}

function setEffects(mode: EffectMode, max?: number) {
  effectMode = mode;
  if (typeof max === 'number' && Number.isFinite(max)) maxEffects = Math.max(1, Math.min(4, Math.round(max)));
  director = createDirector();
}

function frame(raw: Partial<AudioFeatures>, index: number, jpegQuality = 0.9, profile = false) {
  if (!cfg || !canvas || !(renderer || fx) || !state) throw new Error('not initialised');
  const nowMs = (index * 1000) / cfg.fps;
  const timeS = nowMs / 1000;
  const features = normalizeFeatures(raw);
  const preset = presetById(cfg.presetId ?? '');

  const target = mapAudioToParams(features, preset, timeS);
  params = params ? blendParams(params, target, SMOOTHING) : target;

  let sceneFrame: VisualSceneFrame | null = null;
  let tick = { sceneIndex: -1, advanced: false, reason: null as string | null, fade: 1 };
  if (scenes.length > 0) {
    const previousIndex = state.index;
    const result = tickShow(state, scenes, features, nowMs, cfg.show);
    state = result.state;
    const current = media[result.sceneIndex] ?? null;
    const fade = showFade(state, nowMs, cfg.show);
    const previous = fade < 1 ? media[previousIndex] ?? null : null;
    sceneFrame = { current, previous: previous !== current ? previous : null, mix: fade };
    tick = { sceneIndex: result.sceneIndex, advanced: result.advanced, reason: result.reason, fade };
  }

  let picks: EffectPick[] = [];
  if (effectMode === 'off' || !fx) {
    picks = [];
  } else if (Array.isArray(effectMode)) {
    picks = orderPicks(effectMode.map((e) => ({ id: e.id, amount: typeof e.amount === 'number' ? e.amount : 0.7 })));
  } else {
    const directed = directEffects(director, features, nowMs, String(tick.sceneIndex), { max: maxEffects, seed: cfg.seed ?? 0 });
    director = directed.state;
    picks = directed.picks;
  }
  const t0 = profile ? performance.now() : 0;
  if (fx) fx.render(preset, params, features, timeS, sceneFrame, picks, cfg.seed ?? 0);
  else renderer?.render(preset, params, timeS, sceneFrame);
  let renderMs = 0;
  if (profile) {
    // Nur im Messpfad: gl.finish() erzwingt das Ende der GPU-Arbeit, damit Render- und Lesezeit getrennt sind.
    (canvas.getContext('webgl2') ?? canvas.getContext('webgl'))?.finish();
    renderMs = performance.now() - t0;
  }
  const t1 = profile ? performance.now() : 0;
  const jpeg = jpegQuality > 0 ? canvas.toDataURL('image/jpeg', jpegQuality) : null;
  const info = { ...tick, skippedScenes: skipped, effects: picks.map((p) => p.id) };
  return profile ? { info, jpeg, timing: { renderMs, encodeMs: performance.now() - t1 } } : { info, jpeg };
}

function blobBase64(source: HTMLCanvasElement, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    source.toBlob((blob) => {
      if (!blob) { reject(new Error('toBlob failed')); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(blob);
    }, 'image/jpeg', quality);
  });
}

async function burst(raw: Partial<AudioFeatures>, startIndex: number, count: number, jpegQuality = 0.8) {
  if (!canvas) throw new Error('not initialised');
  const total0 = performance.now();
  let renderMs = 0;
  const pending: Array<Promise<string>> = [];
  for (let i = 0; i < count; i += 1) {
    const r0 = performance.now();
    frame(raw, startIndex + i, 0);
    renderMs += performance.now() - r0;
    // toBlob nimmt den Bildinhalt sofort (im selben Task) und kodiert danach nebenlaeufig.
    pending.push(blobBase64(canvas, jpegQuality));
  }
  const jpegs = await Promise.all(pending);
  return { jpegs, totalMs: performance.now() - total0, renderMs };
}

function dispose() {
  renderer?.dispose();
  fx?.dispose();
  renderer = null;
  fx = null;
  for (const m of media) {
    if (m instanceof HTMLVideoElement) {
      m.pause();
      m.removeAttribute('src');
      m.load();
    }
  }
  media = [];
  scenes = [];
  state = null;
  params = null;
}

window.__vis = { init, frame, burst, setEffects, setLook, compiledEffects: () => (fx ? fx.compiledEffects() : []), dispose };
