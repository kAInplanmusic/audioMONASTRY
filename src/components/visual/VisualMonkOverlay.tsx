import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { useVisualStream } from '../../hooks/useVisualStream';
import { useStreamResolution } from '../../hooks/useStreamResolution';
import { STREAM_FPS, STREAM_PRESETS, isStreamFps, isStreamPresetId, logicalCanvas, streamSizeLabel } from '../../core/visual/streamResolution';
import { createFallbackPublisher, studioTokenFromCookie } from '../../utils/visualMjpeg';
import { createWebGpuVisualRenderer, type WebGpuVisualRenderer } from '../../core/visual/webgpuRenderer';
import { webRTCManager } from '../../utils/WebRTCManager';
import { VisualFeatureBus } from '../../core/visual/featureBus';
import { mapAudioToParams, blendParams } from '../../core/visual/audioReactive';
import { VISUAL_PRESETS, presetById } from '../../core/visual/visualPresets';
import { createRendererState, renderFrame } from '../../core/visual/canvasRenderer';
import { createWebGLVisualRenderer, type VisualRendererKind, type WebGLVisualRenderer } from '../../core/visual/webglRenderer';
import { IDLE_AUDIO_FEATURES, type AudioFeatures, type VisualParams } from '../../core/visual/types';
import { composeLayers } from '../../visuals/layerCompositor';
import { useVisualShow } from '../../hooks/useVisualShow';
import { ALL_BANK_SCENES } from '../../visuals/visualBank';
import { sessionCredits } from '../../visuals/bankCredits';
import { CreditsPanel } from './CreditsPanel';
import { TEXTZEILEN_TRIGGER } from '../../visuals/prompts';

interface VisualMonkOverlayProps {
  onClose: () => void;
}

/**
 * VisualMONK – Liveshow-Overlay.
 *
 * Zeichnet die audio-reaktive Visualisierung auf ein main-thread-Canvas und
 * stellt sie als MediaStream bereit (Ghostuser 6 / Beamer). Der Audio-Tap läuft
 * über `audioEngine.createVisualAnalyser()` (reiner Fan-out am V2-Ausgang);
 * ohne Wiedergabe bleibt die Show im Ruhezustand.
 */
export const VisualMonkOverlay: React.FC<VisualMonkOverlayProps> = ({ onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const busRef = useRef<VisualFeatureBus | null>(null);
  const stateRef = useRef(createRendererState(220));
  const paramsRef = useRef<VisualParams>(mapAudioToParams(IDLE_AUDIO_FEATURES, VISUAL_PRESETS[0], 0));
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);
  // UI-P1-002 (A11y): Dialog-Fokus (Initial + Fokusfalle) und Reduced-Motion.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const reducedMotionRef = useRef(false);
  // UI-P1-002: eigener Zeitanker für die Show. Unter Reduced-Motion läuft die
  // Show-Uhr NICHT weiter (siehe tick-Aufruf im Frame) – ohne ihn wechselt die
  // Szene mitten im Standbild und die Zusage „identische Frames" bricht.
  const showClockRef = useRef<number | null>(null);
  useEffect(() => {
    const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    if (!mq) return;
    const apply = () => { reducedMotionRef.current = mq.matches; setReducedMotion(mq.matches); };
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);
  // Beim Öffnen den Fokus in den Dialog holen (Keyboard/Screenreader).
  useEffect(() => { dialogRef.current?.focus(); }, []);
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus(); }
  };
  const [presetId, setPresetId] = useState<string>(VISUAL_PRESETS[0].id);
  const [audioLinked, setAudioLinked] = useState(false);
  const presetRef = useRef(presetId);
  useEffect(() => { presetRef.current = presetId; }, [presetId]);
  const { status: streamStatus, start: startStream, stop: stopStream } = useVisualStream();
  // Stream-Auflösung (Betreiber 2026-10-06): eigene Auflösung des Streams,
  // unabhängig vom Gerät, auf dem gesendet wird. Die Zeichenfläche hat genau
  // diese Größe; die Vorschau zeigt sie eingepasst (Letterbox).
  const streamRes = useStreamResolution();
  const streamSizeRef = useRef(streamRes.size);
  useEffect(() => { streamSizeRef.current = streamRes.size; }, [streamRes.size]);
  /**
   * VISUAL-P1-001: MJPEG-Fallback. Der Publisher laeuft die ganze Zeit, sendet
   * aber NUR, wenn ein Beamer am MJPEG-Strom haengt (Server meldet die
   * Zuschauerzahl) - ohne Zuschauer wird kein Frame enkodiert.
   */
  const fallbackPublisherRef = useRef<ReturnType<typeof createFallbackPublisher> | null>(null);

  // VISUAL-P1-005/P1-008: Renderer-Umschalter. Canvas2D bleibt die Referenz,
  // WebGL das Upgrade. Seit VISUAL-P1-008 zeichnet auch der GL-Pfad Show-Szenen
  // (Bild/Clip als Textur) — der Wechsel ist deshalb auch während einer Show möglich.
  // VISUAL-P1-009: dritter Pfad. Reihenfolge im Umschalter: Canvas2D -> WebGL -> WebGPU.
  const [rendererMode, setRendererMode] = useState<'canvas2d' | 'gl' | 'gpu'>('canvas2d');
  const [rendererKind, setRendererKind] = useState<VisualRendererKind>('canvas2d');
  /** WebGPU-Pfad kann Show-Szenen nicht darstellen - das wird sichtbar gemeldet. */
  const [sceneIgnored, setSceneIgnored] = useState(false);
  const glRendererRef = useRef<WebGLVisualRenderer | null>(null);
  // VISUAL-P1-009: WebGPU-Renderer + Meldung, wenn eine Show-Szene im GPU-Pfad
  // nicht dargestellt wird (Grenze des dritten Pfads, sichtbar statt still).
  const gpuRendererRef = useRef<WebGpuVisualRenderer | null>(null);
  const sceneIgnoredRef = useRef(false);

  // VisualMONK #5: Show-Orchestrator (Szenen aus Bildern/Clips, audio-reaktiv).
  // Über eine Ref erreichbar, damit die RAF-Schleife (Deps `[]`) ihn nutzen kann.
  const show = useVisualShow();
  const showRef = useRef(show);
  useEffect(() => { showRef.current = show; });

  /**
   * MEDIA-2026-11-04-005: Namensnennung. Nur Clips, die wirklich gezeichnet
   * wurden, kommen in die Session-Liste (nicht alles, was in der Bank liegt
   * oder in der Showliste steht). Die Daten bleiben im React-State; nichts
   * wird auf dem Geraet gespeichert. Export nur per Klick (CreditsPanel).
   */
  const shownRef = useRef<Set<string>>(new Set());
  const [shownSrcs, setShownSrcs] = useState<string[]>([]);
  const markShown = useCallback((src: string) => {
    if (!src || shownRef.current.has(src)) return;
    shownRef.current.add(src);
    setShownSrcs((prev) => [...prev, src]);
  }, []);
  const markCurrentShown = useCallback(() => {
    const api = showRef.current;
    if (!api.playing) return;
    const src = api.scenes[api.currentIndex]?.src;
    if (src) markShown(src);
  }, [markShown]);
  const shownCredits = useMemo(() => sessionCredits(shownSrcs), [shownSrcs]);

  // Vorrats-Bank: Vorlagen (8) + importierte Themen-Clips (MONASTRY/Visuals)
  // als Show-Szenen laden (0 USD, kein RunPod-Aufruf). Einmalig beim Öffnen des
  // Visualizers; StrictMode-fest per Ref.
  const bankLoadedRef = useRef(false);
  useEffect(() => {
    if (bankLoadedRef.current || show.scenes.length > 0) return;
    bankLoadedRef.current = true;
    for (const b of ALL_BANK_SCENES) {
      show.addScene({ prompt: b.motiv, kind: 'clip', src: b.src, label: b.label, mediaDurationS: b.mediaDurationS });
    }
  }, [show.scenes.length, show]);

  // Auto-Start: genau EINMAL, sobald die Bank geladen ist. Vorher hing der
  // Effekt an `show` (neues Objekt je Render) und an `!show.playing` — damit
  // hat jeder Render ein bewusstes „SHOW STOP“ sofort wieder rückgängig
  // gemacht und die Show auf Szene 0 zurückgesetzt.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (!bankLoadedRef.current || show.scenes.length === 0) return;
    autoStartedRef.current = true;
    show.startShow();
  }, [show.scenes.length, show]);

  // „LEEREN“ gibt die Bank wieder frei: beim nächsten Öffnen/Szenenwechsel darf
  // sie erneut geladen und die Show wieder gestartet werden.
  const clearShowAndReset = useCallback(() => {
    bankLoadedRef.current = false;
    autoStartedRef.current = false;
    show.clearShow();
  }, [show]);

  const [rendererError, setRendererError] = useState('');

  const toggleStream = useCallback(() => {
    if (streamStatus === 'live') {
      stopStream();
      fallbackPublisherRef.current?.stop();
      fallbackPublisherRef.current = null;
    } else {
      // Der Fallback laeuft parallel zum SFU-Pfad (er springt nur ein, wenn beim
      // Beamer kein WebRTC ankommt) - er kostet nichts, solange niemand schaut.
      if (!fallbackPublisherRef.current) {
        fallbackPublisherRef.current = createFallbackPublisher({
          getCanvas: () => canvasRef.current,
          token: studioTokenFromCookie(),
        });
        fallbackPublisherRef.current.start();
      }
      const stream = startStream(canvasRef.current, streamRes.fps);
      const track = stream?.getVideoTracks()[0];
      if (track) {
        // An Ghostuser 6 senden (SFU-Producer bzw. P2P-Main-Stream).
        try { webRTCManager.publishVisualTrack(track); } catch { /* Transport nicht bereit */ }
      }
    }
  }, [streamStatus, startStream, stopStream, streamRes.fps]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Canvas2D ist der Referenzpfad; im GL-Modus gibt es keinen 2D-Kontext.
    const ctx = rendererMode === 'canvas2d' ? canvas.getContext('2d') : null;
    if (rendererMode === 'gl') {
      const gl = createWebGLVisualRenderer(canvas);
      glRendererRef.current = gl;
      setRendererKind(gl ? gl.kind : 'canvas2d');
      if (!gl) setRendererError('WebGL nicht verfügbar – Canvas2D bleibt aktiv.');
    } else if (rendererMode === 'gpu') {
      // WebGPU ist asynchron (Adapter + Geraet) und wird ehrlich gemeldet, wenn
      // es fehlt - der Canvas bleibt dann beim 2D-Pfad.
      let cancelled = false;
      void createWebGpuVisualRenderer(canvas).then((gpu) => {
        if (cancelled) { gpu?.dispose(); return; }
        gpuRendererRef.current = gpu;
        setRendererKind(gpu ? 'webgpu' : 'canvas2d');
        if (!gpu) setRendererError('WebGPU nicht verfügbar – WebGL/Canvas2D bleibt aktiv.');
        if (gpu) ctx?.clearRect(0, 0, canvas.width, canvas.height);
      });
      return () => {
        cancelled = true;
        gpuRendererRef.current?.dispose();
        gpuRendererRef.current = null;
      };
    } else {
      glRendererRef.current = null;
      setRendererKind('canvas2d');
    }
    if (!ctx && !glRendererRef.current) return;

    let disposed = false;
    let lastTapAttempt = 0;

    const frame = (now: number) => {
      if (disposed) return;
      const dt = lastRef.current ? Math.min(0.1, (now - lastRef.current) / 1000) : 1 / 60;
      lastRef.current = now;

      // Audio-Tap nachziehen, sobald die Engine spielt (Fan-out am V2-Ausgang).
      if (!analyserRef.current && now - lastTapAttempt > 2000) {
        lastTapAttempt = now;
        const analyser = audioEngine.createVisualAnalyser();
        if (analyser) {
          analyserRef.current = analyser;
          busRef.current = new VisualFeatureBus(analyser, undefined, () =>
            // VISUAL-P1-002: Tempo aus dem V2-Transport (0 wenn gestoppt) –
            // Energie kommt aus dem Analyser, BPM darf nicht still 0 bleiben.
            audioEngine.getIsPlaying() ? audioEngine.getBpm() : 0,
          );
          setAudioLinked(true);
        }
      }

      let features: AudioFeatures = IDLE_AUDIO_FEATURES;
      try {
        if (busRef.current) features = busRef.current.read();
      } catch {
        features = IDLE_AUDIO_FEATURES;
      }

      const preset = presetById(presetRef.current);
      // UI-P1-002: Reduced-Motion friert die Feldbewegung (kein Flackern/Drift).
      const animTimeS = reducedMotionRef.current ? 0 : now / 1000;
      const animDt = reducedMotionRef.current ? 0 : dt;
      // Reduced-Motion: keine Audio-Reaktivität/Glättung -> Parameter stehen still.
      const target = reducedMotionRef.current
        ? mapAudioToParams(IDLE_AUDIO_FEATURES, preset, 0)
        : mapAudioToParams(features, preset, animTimeS);
      // Reduced-Motion: ohne Glättungs-Animation direkt auf den Zielwert (Frames identisch).
      const smoothed = reducedMotionRef.current ? target : blendParams(paramsRef.current, target, 0.35);
      // Layer-Compositor: L2–L5 (Abstraktion, Textgewicht, Atmosphäre) über die
      // Preset-Parameter (L0) mischen; L6 = dieselben Audio-Features wie im Bus.
      paramsRef.current = reducedMotionRef.current
        ? smoothed
        : composeLayers(features, smoothed);

      // Zeichenfläche = Stream-Auflösung (nicht Bildschirm des Senders);
      // captureStream folgt der Canvas-Größe auch während eines laufenden Streams.
      const streamSize = streamSizeRef.current;
      if (canvas.width !== streamSize.width || canvas.height !== streamSize.height) {
        canvas.width = streamSize.width;
        canvas.height = streamSize.height;
      }
      const logical = logicalCanvas(streamSize);
      const dpr = logical.scale;
      const cssW = logical.width;
      const cssH = logical.height;
      // Show-Orchestrator: entscheidet den Szenenwechsel (Dauer/Beat/Energie).
      const showApi = showRef.current;
      // UI-P1-002: Reduced-Motion hält die GANZE Show an. `draw`/`frame` rechnen
      // intern mit `performanceNow()` (eigene Uhr) und die Szenen-Clips sind
      // Videos, die von selbst weiterlaufen – beides macht die Canvas-Fläche
      // unruhig, obwohl Feldbewegung und Features längst eingefroren sind.
      showApi.setFrozen(reducedMotionRef.current);
      if (reducedMotionRef.current) {
        // UI-P1-002 (Befund 2026-09-29): Bisher bekam der Orchestrator IMMER die
        // Wanduhr – die Feldbewegung war eingefroren, sein Szenenwechsel nicht.
        // Seine Regeln hängen an beidem:
        //   * `elapsedS = (nowMs - startedAtMs)/1000` → bei laufender Uhr feuert
        //     `elapsedS >= durationS` und es folgt ein NEUES Bild,
        //   * ab `minDwellS` wechselt auch ein Beat (`features.onset`) oder ein
        //     Energiesprung – ganz ohne Uhr.
        // Reduced-Motion heisst hier: die Show PAUSIERT (Standbild), statt im
        // Standbild weiterzuschalten. Deshalb der feste Zeitanker (erstes Frame
        // nach Aktivierung; höchstens ein Wechsel, danach steht elapsedS auf 0)
        // und dieselben Ruhe-Features, die oben schon die Parameter speisen.
        showClockRef.current ??= now;
        showApi.tick(showClockRef.current, IDLE_AUDIO_FEATURES);
      } else {
        showClockRef.current = null;
        showApi.tick(now, features);
      }

      const gpu = gpuRendererRef.current;
      const gl = gpu ? null : glRendererRef.current;
      if (gpu) {
        gpu.resize(canvas.width, canvas.height);
        // Show-Szenen gibt es nur im WebGL-Pfad; das wird gemeldet, nicht verschwiegen.
        const scene = showApi.playing ? showApi.frame() : null;
        const result = gpu.render(preset, paramsRef.current, animTimeS, scene);
        if (result.sceneIgnored !== sceneIgnoredRef.current) {
          sceneIgnoredRef.current = result.sceneIgnored;
          setSceneIgnored(result.sceneIgnored);
        }
      } else if (gl) {
        gl.resize(canvas.width, canvas.height);
        // VISUAL-P1-008: Show-Szenen auch im GL-Pfad als Textur (kein drawImage).
        const scene = showApi.playing ? showApi.frame() : null;
        gl.render(preset, paramsRef.current, animTimeS, scene);
        // MEDIA-2026-11-04-005: erst wenn die Szene dekodiert ist, gilt sie als gezeigt.
        if (scene?.current) markCurrentShown();
      } else if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderFrame(ctx, cssW, cssH, preset, paramsRef.current, stateRef.current, animDt, !reducedMotionRef.current);
        // Canvas2D: Szene per drawImage über die Visualisierung (Crossfade).
        if (showApi.playing && showApi.draw(ctx, cssW, cssH)) markCurrentShown();
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      disposed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (glRendererRef.current) {
        glRendererRef.current.dispose();
        glRendererRef.current = null;
      }
      if (analyserRef.current) {
        try { audioEngine.disconnectVisualAnalyser(analyserRef.current); } catch { /* ignore */ }
        analyserRef.current = null;
        busRef.current = null;
      }
    };
  }, [markCurrentShown, rendererMode]);

  // Für das Browser-Gate (scripts/visual-monk-gate.cjs) und die Diagnose:
  // welcher Renderer zeichnet tatsächlich? Kein stiller Erfolg — steht auch als
  // `data-renderer` am Dialog.
  useEffect(() => {
    (window as unknown as { __visualRenderer?: string }).__visualRenderer = rendererKind;
  }, [rendererKind]);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      className="fixed inset-0 z-[80] bg-black/95 backdrop-blur-sm flex flex-col outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="Visual-Liveshow"
      data-renderer={rendererKind}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-white/10">
        <span className="text-[10px] font-bold tracking-widest text-fuchsia-300">VISUAL · LIVESHOW</span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${audioLinked ? 'border-emerald-400/50 text-emerald-300' : 'border-neutral-600 text-neutral-400'}`}>
          {audioLinked ? 'AUDIO LIVE' : 'wartet auf Wiedergabe'}
        </span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${streamStatus === 'live' ? 'border-cyan-400/60 text-cyan-300' : streamStatus === 'unsupported' ? 'border-amber-400/50 text-amber-300' : 'border-neutral-700 text-neutral-400'}`}>
          {streamStatus === 'live' ? 'GHOSTUSER 6 · STREAM AN' : streamStatus === 'unsupported' ? 'Stream nicht unterstützt' : 'Stream aus'}
        </span>
        <span
          className={`text-[9px] px-1.5 py-0.5 rounded-full border ${rendererKind === 'canvas2d' ? 'border-neutral-700 text-neutral-400' : 'border-emerald-400/50 text-emerald-300'}`}
          title={rendererMode !== 'canvas2d' && rendererKind === 'canvas2d'
            ? `${rendererMode === 'gpu' ? 'WebGPU' : 'WebGL'} nicht verfügbar – Canvas2D aktiv`
            : sceneIgnored ? 'Renderer: webgpu (Show-Szenen nur im WebGL-Pfad)' : `Renderer: ${rendererKind}`}
        >
          {rendererKind.toUpperCase()}
        </span>
        {/* L4 · Textzeile der Szene — aus dem Katalog, wechselt mit dem Szenenwechsel. */}
        <span
          className="text-[9px] px-1.5 py-0.5 rounded border border-neutral-700 text-neutral-300 tracking-widest"
          title="L4 · Textzeile der Szene (TEXTZEILEN_TRIGGER)"
        >
          {TEXTZEILEN_TRIGGER[show.currentIndex % TEXTZEILEN_TRIGGER.length]}
        </span>
        <button
          type="button"
          onClick={() => setRendererMode((m) => (m === 'canvas2d' ? 'gl' : m === 'gl' ? 'gpu' : 'canvas2d'))}
          aria-pressed={rendererMode !== 'canvas2d'}
          data-renderer-mode={rendererMode}
          title="Renderer wechseln: WebGL (GPU-Renderer) oder Canvas2D (Referenz) – auch während einer laufenden Show (VISUAL-P1-008)"
          className={`px-2 py-1 rounded-full text-[9px] font-bold tracking-widest border transition-colors ${rendererMode === 'gl' ? 'border-emerald-400/60 text-emerald-200 bg-emerald-400/10' : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}
        >
          {rendererMode === 'gl' ? 'WEBGL' : rendererMode === 'gpu' ? 'WEBGPU' : 'CANVAS2D'}
        </button>
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-[9px] text-neutral-400 tracking-widest">
          AUFLÖSUNG
          <select
            aria-label="Stream-Auflösung"
            value={streamRes.preset}
            onChange={(e) => { if (isStreamPresetId(e.target.value)) streamRes.setPreset(e.target.value); }}
            className="bg-black/60 border border-neutral-700 rounded px-1.5 py-1 text-[10px] text-neutral-200"
          >
            {STREAM_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-[9px] text-neutral-400 tracking-widest" title={streamStatus === 'live' ? 'Bildrate vor dem Start wählen' : 'Bildrate des Streams'}>
          FPS
          <select
            aria-label="Stream-Bildrate"
            value={streamRes.fps}
            disabled={streamStatus === 'live'}
            onChange={(e) => { const f = Number(e.target.value); if (isStreamFps(f)) streamRes.setFps(f); }}
            className="bg-black/60 border border-neutral-700 rounded px-1.5 py-1 text-[10px] text-neutral-200 disabled:opacity-50"
          >
            {STREAM_FPS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <span
          data-testid="stream-size"
          className="text-[9px] px-1.5 py-0.5 rounded-full border border-cyan-400/40 text-cyan-200 font-mono"
          title={streamRes.receiver ? `Beamer meldet ${streamRes.receiver.width}×${streamRes.receiver.height} @${streamRes.receiver.devicePixelRatio}x` : 'Kein Beamer verbunden – Auto nutzt 1920×1080'}
        >
          {streamSizeLabel(streamRes.size)}
        </span>
        <button
          type="button"
          onClick={toggleStream}
          className="px-3 py-1.5 rounded-full text-[10px] font-bold tracking-widest border border-cyan-400/50 text-cyan-200 hover:bg-cyan-400/10 transition-colors"
          aria-pressed={streamStatus === 'live'}
        >
          {streamStatus === 'live' ? 'STREAM AUS' : 'AN GHOSTUSER 6'}
        </button>
        {/* MEDIA-2026-11-04-005: Namensnennung der tatsächlich gezeigten Clips. */}
        <CreditsPanel credits={shownCredits.entries} uncredited={shownCredits.uncredited} />
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-full text-[10px] font-bold tracking-widest border border-neutral-600 text-neutral-300 hover:bg-white/5 transition-colors"
        >
          SCHLIESSEN
        </button>
      </div>

      <div className="flex gap-1.5 overflow-x-auto px-3 py-2 border-b border-white/5">
        {VISUAL_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPresetId(p.id)}
            title={p.description}
            className={`shrink-0 px-2.5 py-1 rounded-full text-[9px] tracking-wide border transition-colors ${presetId === p.id ? 'border-fuchsia-400/70 text-fuchsia-200 bg-fuchsia-400/10' : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {rendererError && <span className="text-[10px] text-red-400">{rendererError}</span>}

      {/* VisualMONK #5: Show – Szenen aus Bildern/Clips, audio-reaktiver Ablauf */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-white/5">
        <span className="text-[9px] font-bold tracking-widest text-cyan-300">SHOW</span>
        <button
          type="button"
          onClick={show.playing ? show.stopShow : show.startShow}
          disabled={show.summary.scenes === 0}
          aria-pressed={show.playing}
          title="Show auf dem Canvas abspielen – Szenenwechsel nach Dauer, Beat oder Energie"
          className={`px-2.5 py-1.5 rounded-full text-[10px] font-bold tracking-widest border transition-colors disabled:opacity-40 ${show.playing ? 'border-emerald-400/70 text-emerald-200 bg-emerald-400/10' : 'border-neutral-600 text-neutral-300 hover:bg-white/5'}`}
        >
          {show.playing ? 'SHOW STOP' : 'SHOW START'}
        </button>
        <button
          type="button"
          onClick={() => void show.mergeShow()}
          disabled={Boolean(show.busy) || show.summary.clips < 1}
          title="Clips der Show serverseitig zu einem mp4 zusammenführen (ffmpeg)"
          className="px-2.5 py-1.5 rounded-full text-[10px] font-bold tracking-widest border border-neutral-600 text-neutral-300 hover:bg-white/5 disabled:opacity-40 transition-colors"
        >
          ZUSAMMENFÜHREN
        </button>
        {show.scenes.length > 0 && (
          <button
            type="button"
            onClick={clearShowAndReset}
            title="Show leeren (Medien bleiben in der Bibliothek)"
            className="px-2 py-1.5 rounded-full text-[10px] tracking-widest border border-neutral-700 text-neutral-400 hover:text-red-300 transition-colors"
          >
            LEEREN
          </button>
        )}
        <span className="text-[9px] text-neutral-400">
          {show.summary.scenes} Szenen · {show.summary.clips} Clips · {show.summary.images} Bilder · {Math.round(show.summary.totalS)} s
        </span>
        {show.playing && (
          <span className="text-[9px] text-emerald-300">
            ▶ {show.currentLabel || 'Szene 1'}{show.lastReason ? ` · Wechsel: ${show.lastReason}` : ''}
          </span>
        )}
        {show.busy && <span className="text-[9px] text-amber-300">{show.busy}</span>}
        {show.mergedUrl && (
          <a href={show.mergedUrl} target="_blank" rel="noreferrer" className="text-[10px] text-cyan-300 underline">
            SHOW-MP4 {show.mergedStore ? `(${show.mergedStore})` : ''}
          </a>
        )}
        {show.error && <span className="text-[10px] text-red-400">{show.error}</span>}
      </div>

      {show.scenes.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-3 py-1.5 border-b border-white/5">
          {show.scenes.map((scene, i) => (
            <span
              key={scene.id}
              className={`shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-full text-[9px] border ${show.playing && i === show.currentIndex ? 'border-emerald-400/70 text-emerald-200' : 'border-neutral-700 text-neutral-400'}`}
            >
              <span className="text-[8px] tracking-wider opacity-70">{scene.kind === 'clip' ? 'CLIP' : 'BILD'}</span>
              <span className="max-w-[10rem] truncate">{scene.label}</span>
              <span className="opacity-50">{Math.round(scene.durationS)}s</span>
              <button
                type="button"
                onClick={() => show.removeScene(scene.id)}
                title="Szene entfernen"
                aria-label={`Szene ${scene.label} entfernen`}
                className="text-neutral-500 hover:text-red-300 transition-colors"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 relative">
        {/* key: ein Canvas kann nur EINEN Kontexttyp haben — beim Renderer-Wechsel
            wird das Element bewusst neu erzeugt (VISUAL-P1-005). */}
        <canvas key={rendererMode} ref={canvasRef} data-testid="visual-canvas" className="w-full h-full block object-contain" />

      </div>
    </div>
  );
};
