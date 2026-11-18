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
import { applyLayerRole } from './layerRoles';
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
  /** Ebenen-Rollen (Clips folgen Bass/Energie, Bilder Mitten/Höhen); Standard an. */
  layerRoles?: boolean;
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
  /** Ob der Rohframe-Pfad (GPU-Packer yuv420p) auf dieser GPU/Aufloesung moeglich ist. */
  rawSupported(): boolean;
  /**
   * Rohframe-Takt in der Seite: rendert mit eigenem Zeitgeber, packt auf der GPU in yuv420p und schickt die Frames per
   * WebSocket an `url` (Loopback des Renderers). Kein Aufruf pro Frame: Antworten der Browser-Steuerleitung (CDP) hingen
   * waehrend der Uebertragung ~100 ms hinterher (gemessen). Features kommen als Textnachricht ueber denselben Socket,
   * Zaehler und Zeiten gehen alle 250 ms als Textnachricht zurueck. Resolves, sobald der Socket offen ist.
   * Hoechstens `MAX_INFLIGHT` Frames unbestaetigt (Gegendruck); ein Frame Verzug, damit GPU, Auslesen und Uebertragung ueberlappen.
   */
  startStream(url: string): Promise<void>;
  stopStream(): void;
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
const STATS_EVERY_MS = 250;
interface SinkState { ws: WebSocket; url: string; inflight: number; error: string | null; wake: Array<() => void>; sentAt: number[]; ackMs: number }
interface StreamState {
  running: boolean;
  sink: SinkState;
  features: Partial<AudioFeatures>;
  index: number;
  frames: number;
  late: number;
  lastFrameMs: number;
  info: PodFrameInfo | null;
  /** Gleitende Mittel in ms (Faktor 0.1): Render+Packen anstossen, Fence+Auslesen, Wartezeit auf freie Sendeplaetze. */
  timing: { renderIssueMs: number; fenceMs: number; getMs: number; sendWaitMs: number };
}
let stream: StreamState | null = null;
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

  // Ebenen-Rolle der gezeigten Szene gewichtet die Parameter-Abbildung; Schnitt und Effekt-Regie nutzen die rohen Features.
  const role = cfg.layerRoles === false ? features : applyLayerRole(features, scenes[tick.sceneIndex]?.kind);
  const target = mapAudioToParams(role, preset, timeS);
  params = params ? blendParams(params, target, SMOOTHING) : target;

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

function openSink(url: string, onFeatures: (features: Partial<AudioFeatures>) => void): Promise<SinkState> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const state: SinkState = { ws, url, inflight: 0, error: null, wake: [], sentAt: [], ackMs: 0 };
    const notify = () => { for (const wake of state.wake.splice(0)) wake(); };
    ws.onopen = () => resolve(state);
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {                         // Textnachricht = Features vom Renderer
        try { const parsed = JSON.parse(event.data); if (parsed && typeof parsed === 'object') onFeatures(parsed); } catch { /* ignorieren */ }
        return;
      }
      state.inflight = Math.max(0, state.inflight - 1);            // 1-Byte-Ack je Frame
      const sent = state.sentAt.shift();
      if (sent !== undefined) { const ms = performance.now() - sent; state.ackMs = state.ackMs === 0 ? ms : state.ackMs * 0.9 + ms * 0.1; }
      notify();
    };
    ws.onerror = () => { state.error = state.error ?? 'frame sink error'; notify(); reject(new Error('frame sink error')); };
    ws.onclose = (event) => { state.error = state.error ?? 'frame sink closed ' + event.code; notify(); };
  });
}

/** Schickt einen Frame; wartet nur, wenn schon MAX_INFLIGHT unbestaetigt sind. Liefert die Wartezeit in ms. */
async function sendToSink(state: SinkState, bytes: Uint8Array): Promise<number> {
  const t0 = performance.now();
  while (state.inflight >= MAX_INFLIGHT && !state.error) await new Promise<void>((resolve) => state.wake.push(resolve));
  if (state.error) throw new Error(state.error);
  state.ws.send(bytes);      // Chromium kopiert die Bytes sofort; der Ring-Puffer darf danach wiederverwendet werden
  state.inflight += 1;
  state.sentAt.push(performance.now());
  return performance.now() - t0;
}

function rawSupported(): boolean {
  return ensurePacker() !== null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runStream(st: StreamState): Promise<void> {
  const p = ensurePacker();
  if (!p || !cfg) return;
  const interval = 1000 / cfg.fps;
  let deadline = performance.now();
  let nextStats = deadline;
  const ema = (old: number, value: number) => (old === 0 ? value : old * 0.9 + value * 0.1);
  try {
    while (st.running) {
      const begin = performance.now();
      const { info } = frame(st.features, st.index, 0);
      const slot = rawNextSlot;
      rawNextSlot ^= 1;
      p.issue(slot);
      const issued = performance.now();
      st.timing.renderIssueMs = ema(st.timing.renderIssueMs, issued - begin);
      if (rawPending !== null) {
        const bytes = await p.fetch(rawPending);
        st.timing.fenceMs = ema(st.timing.fenceMs, performance.now() - issued);
        st.timing.getMs = ema(st.timing.getMs, p.lastGetMs);
        st.timing.sendWaitMs = ema(st.timing.sendWaitMs, await sendToSink(st.sink, bytes));
      }
      rawPending = slot;
      st.index += 1;
      st.frames += 1;
      st.info = info;
      const done = performance.now();
      st.lastFrameMs = done - begin;
      deadline += interval;
      const pause = deadline - done;
      if (pause > 0) {
        await sleep(pause);
      } else {
        st.late += 1;
        deadline = done;                // nicht aufholen: Live zeigt den naechsten Frame, keinen Stau
        await sleep(0);                 // Ereignisse (Acks, Features) abarbeiten lassen
      }
      if (done >= nextStats && st.sink.ws.readyState === WebSocket.OPEN) {
        nextStats = done + STATS_EVERY_MS;
        st.sink.ws.send(JSON.stringify({ type: 'stats', frames: st.frames, late: st.late, lastFrameMs: Math.round(st.lastFrameMs * 10) / 10,
          sceneIndex: st.info?.sceneIndex ?? -1, effects: st.info?.effects ?? [],
          timing: { ...st.timing, ackMs: st.sink.ackMs, bufferedKB: Math.round(st.sink.ws.bufferedAmount / 1024) } }));
      }
    }
  } catch (error) {
    if (st.sink.ws.readyState === WebSocket.OPEN) {
      st.sink.ws.send(JSON.stringify({ type: 'error', message: String((error as Error)?.message ?? error).slice(0, 300) }));
    }
    st.running = false;
  }
}

async function startStream(url: string): Promise<void> {
  stopStream();
  if (!ensurePacker()) throw new Error('raw path unsupported');
  const features: Partial<AudioFeatures> = {};
  let current: StreamState | null = null;
  const sinkState = await openSink(url, (next) => { if (current) current.features = next; else Object.assign(features, next); });
  current = {
    running: true, sink: sinkState, features, index: 0, frames: 0, late: 0, lastFrameMs: 0, info: null,
    timing: { renderIssueMs: 0, fenceMs: 0, getMs: 0, sendWaitMs: 0 },
  };
  stream = current;
  void runStream(current);
}

function stopStream(): void {
  if (!stream) return;
  stream.running = false;
  try { stream.sink.ws.close(); } catch { /* schon zu */ }
  stream = null;
  rawPending = null;
  rawNextSlot = 0;
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
  stopStream();
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

window.__vis = { init, frame, burst, rawSupported, startStream, stopStream, rawSelfTest, setEffects, setLook, compiledEffects: () => (fx ? fx.compiledEffects() : []), dispose };
