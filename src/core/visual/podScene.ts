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
import { createI420Packer, type I420Packer } from './i420Pack';
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

/** Zeiten des Rohframe-Pfads in ms (renderIssueMs: Rendern + Packen anstossen; fenceMs: Abholen des Vorframes; getMs: davon getBufferSubData; sendWaitMs: Wartezeit auf freie Sendeplaetze, also Gegendruck). */
export interface RawTiming { renderIssueMs: number; fenceMs: number; getMs: number; sendWaitMs: number }

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
  /** Ob der Rohframe-Pfad (GPU-Packer yuv420p) auf dieser GPU/Aufloesung moeglich ist. */
  rawSupported(): boolean;
  /**
   * Rohframe-Pfad: rendert Frame `index`, packt ihn auf der GPU in yuv420p und schickt die Bytes des VORHERIGEN Frames
   * per WebSocket an `url` (Loopback des Renderers; fetch/POST waere ~14x langsamer). Ein Frame Verzug, dafuer
   * ueberlappen GPU, Auslesen und Uebertragung. Hoechstens `MAX_INFLIGHT` Frames unbestaetigt (Gegendruck).
   * `emitted` ist false beim allerersten Aufruf.
   */
  frameRaw(features: Partial<AudioFeatures>, index: number, url: string): Promise<{ info: PodFrameInfo; emitted: boolean; timing: RawTiming }>;
  /** Prueft den Packer gegen eine CPU-Referenz (Hoechstabweichung je Ebene in Stufen). Nur fuer Tests/Messung. */
  rawSelfTest(features: Partial<AudioFeatures>, index: number): { maxDiffY: number; maxDiffU: number; maxDiffV: number; bytes: number } | null;
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
const MAX_INFLIGHT = 2;
interface SinkState { ws: WebSocket; url: string; inflight: number; error: string | null; wake: Array<() => void> }
let sink: SinkState | null = null;
let packer: I420Packer | null = null;
let rawPending: number | null = null;
let rawNextSlot = 0;

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

function ensurePacker(): I420Packer | null {
  if (packer) return packer;
  if (!canvas || !cfg || !fx) return null;   // nur mit Medien-Renderer (WebGL2); ohne Medien bleibt der JPEG-Pfad
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) return null;
  packer = createI420Packer(gl, cfg.width, cfg.height);
  return packer;
}

function openSink(url: string): Promise<SinkState> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const state: SinkState = { ws, url, inflight: 0, error: null, wake: [] };
    const notify = () => { for (const wake of state.wake.splice(0)) wake(); };
    ws.onopen = () => resolve(state);
    ws.onmessage = () => { state.inflight = Math.max(0, state.inflight - 1); notify(); };   // 1-Byte-Ack je Frame
    ws.onerror = () => { state.error = state.error ?? 'frame sink error'; notify(); reject(new Error('frame sink error')); };
    ws.onclose = (event) => { state.error = state.error ?? 'frame sink closed ' + event.code; notify(); };
  });
}

/** Schickt einen Frame; wartet nur, wenn schon MAX_INFLIGHT unbestaetigt sind. Liefert die Wartezeit in ms. */
async function sendToSink(url: string, bytes: Uint8Array): Promise<number> {
  if (!sink || sink.url !== url) {
    sink?.ws.close();
    sink = await openSink(url);
  }
  const state = sink;
  const t0 = performance.now();
  while (state.inflight >= MAX_INFLIGHT && !state.error) await new Promise<void>((resolve) => state.wake.push(resolve));
  if (state.error) throw new Error(state.error);
  state.ws.send(bytes);      // Chromium kopiert die Bytes sofort; der Ring-Puffer darf danach wiederverwendet werden
  state.inflight += 1;
  return performance.now() - t0;
}

function rawSupported(): boolean {
  return ensurePacker() !== null;
}

async function frameRaw(raw: Partial<AudioFeatures>, index: number, url: string) {
  const p = ensurePacker();
  if (!p) throw new Error('raw path unsupported');
  const t0 = performance.now();
  const { info } = frame(raw, index, 0);
  const slot = rawNextSlot;
  rawNextSlot ^= 1;
  p.issue(slot);
  const timing: RawTiming = { renderIssueMs: performance.now() - t0, fenceMs: 0, getMs: 0, sendWaitMs: 0 };
  let emitted = false;
  if (rawPending !== null) {
    const t1 = performance.now();
    const bytes = await p.fetch(rawPending);
    timing.fenceMs = performance.now() - t1;     // Warten auf Fence + getBufferSubData (siehe i420Pack.fetch)
    timing.getMs = p.lastGetMs;
    timing.sendWaitMs = await sendToSink(url, bytes);
    emitted = true;
  }
  rawPending = slot;
  return { info, emitted, timing };
}

function rawSelfTest(raw: Partial<AudioFeatures>, index: number) {
  const p = ensurePacker();
  if (!p || !canvas || !cfg) return null;
  frame(raw, index, 0);
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
  const W = cfg.width;
  const H = cfg.height;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const rgba = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  const packed = p.readSync();
  // CPU-Referenz (BT.601 limited). readPixels liefert die unterste Zeile zuerst -> Videozeile r = GL-Zeile H-1-r.
  const px = (x: number, r: number) => { const i = ((H - 1 - r) * W + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
  let dY = 0, dU = 0, dV = 0;
  for (let r = 0; r < H; r += 1) {
    for (let x = 0; x < W; x += 1) {
      const [R, G, B] = px(x, r);
      const y = 16 + (65.481 * R + 128.553 * G + 24.966 * B) / 255;
      dY = Math.max(dY, Math.abs(y - packed[r * W + x]));
    }
  }
  const cw = W / 2;
  const plane = (cw * H) / 2;
  for (let cy = 0; cy < H / 2; cy += 1) {
    for (let cx = 0; cx < cw; cx += 1) {
      let R = 0, G = 0, B = 0;
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const c = px(2 * cx + ox, 2 * cy + oy); R += c[0]; G += c[1]; B += c[2]; }
      R /= 4; G /= 4; B /= 4;
      const u = 128 + (-37.797 * R - 74.203 * G + 112.0 * B) / 255;
      const v = 128 + (112.0 * R - 93.786 * G - 18.214 * B) / 255;
      const o = W * H + cy * cw + cx;
      dU = Math.max(dU, Math.abs(u - packed[o]));
      dV = Math.max(dV, Math.abs(v - packed[o + plane]));
    }
  }
  return { maxDiffY: Math.round(dY * 10) / 10, maxDiffU: Math.round(dU * 10) / 10, maxDiffV: Math.round(dV * 10) / 10, bytes: packed.length };
}

function dispose() {
  sink?.ws.close();
  sink = null;
  packer?.dispose();
  packer = null;
  rawPending = null;
  rawNextSlot = 0;
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

window.__vis = { init, frame, burst, rawSupported, frameRaw, rawSelfTest, setEffects, setLook, compiledEffects: () => (fx ? fx.compiledEffects() : []), dispose };
