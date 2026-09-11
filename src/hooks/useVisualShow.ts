import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createShowState,
  mergeableClips,
  summarizeShow,
  tickShow,
  type ShowScene,
  type ShowState,
} from '../core/visual/showOrchestrator';
import type { AudioFeatures } from '../core/visual/types';
import { formatEtaMs, clipEtaMs } from '../core/ai/vision/clipPipeline';

/** Ein Element, das gezeichnet werden kann (Clip oder Standbild). */
export type ShowMedia = HTMLVideoElement | HTMLImageElement;

interface AddSceneInput {
  prompt: string;
  style?: string;
  kind: 'image' | 'clip';
  /** data-URI oder URL. */
  src: string;
  label?: string;
  durationS?: number;
  /** Clip-Länge, wenn bekannt (begrenzt die Standdauer). */
  mediaDurationS?: number;
}

export interface VisualShowApi {
  scenes: ShowScene[];
  summary: { scenes: number; clips: number; images: number; totalS: number };
  playing: boolean;
  currentIndex: number;
  currentLabel: string;
  /** Grund des letzten Wechsels (duration/beat/energy) – für das Statusband. */
  lastReason: string;
  busy: string;
  error: string;
  /** Wo das zuletzt erzeugte Medium liegt (`r2`/`local`). */
  lastStore: string;
  mergedUrl: string | null;
  mergedStore: string;
  addScene: (input: AddSceneInput) => void;
  removeScene: (id: string) => void;
  clearShow: () => void;
  makeClip: (input: { prompt: string; style?: string; bpm?: number; energy?: number; durationS?: number }) => Promise<void>;
  startShow: () => void;
  stopShow: () => void;
  tick: (nowMs: number, features: AudioFeatures) => void;
  /** Zeichnet die Show auf den Canvas. true = es wurde etwas gezeichnet. */
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => boolean;
  /**
   * Aktueller Show-Frame für den WebGL-Pfad (VISUAL-P1-008): Medien als Textur
   * statt `drawImage`, inklusive Crossfade (`fade` 0..1). `current = null`,
   * solange die Show steht oder das Video noch nicht dekodiert ist.
   */
  frame: () => { current: ShowMedia | null; previous: ShowMedia | null; fade: number };
  mergeShow: () => Promise<void>;
}

const DEFAULT_IMAGE_S = 6;
const DEFAULT_CLIP_S = 8;

function coverFit(ctx: CanvasRenderingContext2D, media: ShowMedia, width: number, height: number, alpha: number): boolean {
  const mw = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const mh = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  if (!mw || !mh) return false;
  const scale = Math.max(width / mw, height / mh);
  const dw = mw * scale;
  const dh = mh * scale;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.drawImage(media, (width - dw) / 2, (height - dh) / 2, dw, dh);
  ctx.globalAlpha = prevAlpha;
  return true;
}

/**
 * VisualMONK – Show aus generierten Bildern/Clips.
 *
 * Der Orchestrator-Kern (`showOrchestrator.ts`) entscheidet, **wann** die
 * nächste Szene kommt; dieser Hook hält die Medien (versteckte `<video>`/
 * `<img>`-Elemente), zeichnet die Show auf das Liveshow-Canvas (→ Ghostuser 6 /
 * Beamer) und führt die Clips auf Wunsch zu einem mp4 zusammen.
 */
export function useVisualShow(): VisualShowApi {
  const [scenes, setScenes] = useState<ShowScene[]>([]);
  const [playing, setPlaying] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [lastReason, setLastReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [lastStore, setLastStore] = useState('');
  const [mergedUrl, setMergedUrl] = useState<string | null>(null);
  const [mergedStore, setMergedStore] = useState('');

  const scenesRef = useRef<ShowScene[]>([]);
  const stateRef = useRef<ShowState>(createShowState(0, 0));
  const playingRef = useRef(false);
  const featuresRef = useRef<AudioFeatures | null>(null);
  const mediaRef = useRef<Map<string, ShowMedia>>(new Map());
  const prevSrcRef = useRef<string | null>(null);
  const counterRef = useRef(0);

  useEffect(() => { scenesRef.current = scenes; }, [scenes]);

  /** Medien-Element zur Szene (versteckt, geloopt) – wird bei Bedarf erzeugt. */
  const mediaFor = useCallback((scene: ShowScene, autoplay: boolean): ShowMedia | null => {
    if (typeof document === 'undefined') return null;
    const known = mediaRef.current.get(scene.src);
    if (known) return known;
    let media: ShowMedia;
    if (scene.kind === 'clip') {
      const video = document.createElement('video');
      video.src = scene.src;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      // Ein nicht angehängtes Video wird von manchen Browsern nicht dekodiert;
      // deshalb hängt es unsichtbar im DOM (bewusst nicht per `display:none`).
      video.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
      document.body.appendChild(video);
      media = video;
    } else {
      const img = document.createElement('img');
      img.src = scene.src;
      img.alt = '';
      media = img;
    }
    mediaRef.current.set(scene.src, media);
    if (autoplay && media instanceof HTMLVideoElement) {
      void media.play().catch(() => { /* Autoplay verweigert – Standbild bleibt */ });
    }
    return media;
  }, []);

  const addScene = useCallback((input: AddSceneInput) => {
    const prompt = input.prompt.trim();
    if (!prompt || !input.src) return;
    counterRef.current += 1;
    const scene: ShowScene = {
      id: `scene-${counterRef.current}`,
      label: (input.label || prompt).slice(0, 48),
      prompt,
      style: input.style,
      kind: input.kind,
      src: input.src,
      durationS: input.durationS ?? (input.kind === 'clip' ? DEFAULT_CLIP_S : DEFAULT_IMAGE_S),
      mediaDurationS: input.mediaDurationS,
    };
    setScenes((prev) => [...prev, scene]);
  }, []);

  const removeScene = useCallback((id: string) => {
    setScenes((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const clearShow = useCallback(() => {
    setScenes([]);
    setPlaying(false);
    playingRef.current = false;
    setCurrentIndex(-1);
    setMergedUrl(null);
  }, []);

  const startShow = useCallback(() => {
    const list = scenesRef.current;
    if (list.length === 0) {
      setError('Keine Szene in der Show – erst "SZENE +" oder "CLIP AUS TEXT".');
      return;
    }
    setError('');
    setLastReason('');
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    stateRef.current = createShowState(0, now, featuresRef.current?.energy ?? 0);
    prevSrcRef.current = null;
    playingRef.current = true;
    setPlaying(true);
    setCurrentIndex(0);
  }, []);

  const stopShow = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
  }, []);

  const tick = useCallback((nowMs: number, features: AudioFeatures) => {
    featuresRef.current = features;
    if (!playingRef.current) return;
    const list = scenesRef.current;
    const result = tickShow(stateRef.current, list, features, nowMs);
    if (result.advanced) {
      prevSrcRef.current = list[Math.min(Math.max(stateRef.current.index, 0), list.length - 1)]?.src ?? null;
      stateRef.current = result.state;
      setCurrentIndex(result.sceneIndex);
      setLastReason(result.reason ?? '');
      // Neuen Clip von vorn abspielen (sonst „hängt“ er am Ende).
      const next = list[result.sceneIndex];
      if (next) {
        const media = mediaFor(next, true);
        if (media instanceof HTMLVideoElement) media.currentTime = 0;
      }
    }
  }, [mediaFor]);

  const draw = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number): boolean => {
    if (!playingRef.current) return false;
    const list = scenesRef.current;
    const index = stateRef.current.index;
    const scene = list[Math.min(Math.max(index, 0), list.length - 1)];
    if (!scene) return false;

    const elapsedS = Math.max(0, (performanceNow() - stateRef.current.startedAtMs) / 1000);
    const fadeS = 0.8;
    const fade = Math.min(1, elapsedS / fadeS);
    const prevSrc = prevSrcRef.current;
    if (prevSrc && fade < 1) {
      const prev = mediaRef.current.get(prevSrc);
      if (prev) coverFit(ctx, prev, width, height, 1);
    }
    const media = mediaFor(scene, true);
    if (!media) return false;
    // Video erst zeigen, wenn ein Bild dekodiert ist (sonst schwarzer Blitz).
    if (media instanceof HTMLVideoElement && media.readyState < 2) return false;
    return coverFit(ctx, media, width, height, fade);
  }, [mediaFor]);

  /**
   * VISUAL-P1-008: derselbe Show-Frame wie `draw`, aber für den WebGL-Renderer.
   * Die Medien werden als Textur hochgeladen statt per `drawImage` gezeichnet;
   * `fade` steuert den Crossfade von der vorherigen zur aktuellen Szene.
   */
  const frame = useCallback((): { current: ShowMedia | null; previous: ShowMedia | null; fade: number } => {
    if (!playingRef.current) return { current: null, previous: null, fade: 1 };
    const list = scenesRef.current;
    const index = stateRef.current.index;
    const scene = list[Math.min(Math.max(index, 0), list.length - 1)];
    if (!scene) return { current: null, previous: null, fade: 1 };

    const elapsedS = Math.max(0, (performanceNow() - stateRef.current.startedAtMs) / 1000);
    const fadeS = 0.8;
    const fade = Math.min(1, elapsedS / fadeS);
    const prevSrc = prevSrcRef.current;
    const previous = prevSrc && fade < 1 ? mediaRef.current.get(prevSrc) ?? null : null;
    const media = mediaFor(scene, true);
    // Video erst zeigen, wenn ein Bild dekodiert ist (sonst schwarzer Blitz).
    if (!media || (media instanceof HTMLVideoElement && media.readyState < 2)) {
      return { current: null, previous, fade };
    }
    return { current: media, previous, fade };
  }, [mediaFor]);

  /** Text→Clip: FLUX-Bild → Wan2.2 (ein Aufruf, ein Ergebnis). */
  const makeClip = useCallback(
    async (input: { prompt: string; style?: string; bpm?: number; energy?: number; durationS?: number }) => {
      const prompt = input.prompt.trim();
      if (!prompt) return;
      setBusy(`CLIP AUS TEXT … (${formatEtaMs(clipEtaMs())})`);
      setError('');
      try {
        const resp = await fetch('/api/ai/vision/clip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            style: input.style,
            bpm: input.bpm || undefined,
            energy: input.energy,
            imageSteps: 25,
            videoSteps: 6,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data?.status !== 'success' || !data?.video) {
          throw new Error(String(data?.message || data?.error || `HTTP ${resp.status}`));
        }
        const store = data?.store?.video === 'r2' ? 'R2' : data?.store?.video === 'local' ? 'lokal' : '';
        setLastStore(store);
        addScene({
          prompt,
          style: input.style,
          kind: 'clip',
          src: String(data.video),
          label: prompt,
          durationS: input.durationS ?? DEFAULT_CLIP_S,
        });
      } catch (e) {
        setError((e as Error).message.slice(0, 200));
      } finally {
        setBusy('');
      }
    },
    [addScene],
  );

  /** Clips der Show zu einem mp4 zusammenführen (ffmpeg, serverseitig). */
  const mergeShow = useCallback(async () => {
    const clips = mergeableClips(scenesRef.current);
    if (clips.length === 0) {
      setError('Keine Clips in der Show – Standbilder kann ffmpeg hier nicht zusammenführen.');
      return;
    }
    setBusy('SHOW ZUSAMMENFÜHREN …');
    setError('');
    try {
      const resp = await fetch('/api/ai/vision/show/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clips: clips.map((s) => (s.src.startsWith('data:') ? { dataUri: s.src, label: s.label } : { url: s.src, label: s.label })),
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.status !== 'success' || !(data?.videoUrl || data?.video)) {
        throw new Error(String(data?.message || data?.error || `HTTP ${resp.status}`));
      }
      const store = data?.store === 'r2' ? 'R2' : data?.store === 'local' ? 'lokal (Server)' : 'direkt';
      setMergedStore(`${store} · ${clips.length} Clips${data?.bytes ? ` · ${(data.bytes / 1_048_576).toFixed(1)} MB` : ''}`);
      setMergedUrl(String(data.videoUrl || data.video));
    } catch (e) {
      setError((e as Error).message.slice(0, 200));
    } finally {
      setBusy('');
    }
  }, []);

  // Aufräumen: laufende Videos stoppen und die versteckten Elemente entfernen.
  useEffect(() => () => {
    for (const media of mediaRef.current.values()) {
      if (media instanceof HTMLVideoElement) {
        try { media.pause(); } catch { /* ignore */ }
        media.remove();
      }
    }
    mediaRef.current.clear();
  }, []);

  const summary = useMemo(() => summarizeShow(scenes), [scenes]);

  return {
    scenes,
    summary,
    playing,
    currentIndex,
    currentLabel: scenes[currentIndex]?.label ?? '',
    lastReason,
    busy,
    error,
    lastStore,
    mergedUrl,
    mergedStore,
    addScene,
    removeScene,
    clearShow,
    makeClip,
    startShow,
    stopShow,
    tick,
    draw,
    frame,
    mergeShow,
  };
}

function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
