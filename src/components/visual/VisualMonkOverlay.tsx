import React, { useCallback, useEffect, useRef, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { useVisualStream } from '../../hooks/useVisualStream';
import { webRTCManager } from '../../utils/WebRTCManager';
import { VisualFeatureBus } from '../../core/visual/featureBus';
import { mapAudioToParams, blendParams } from '../../core/visual/audioReactive';
import { VISUAL_PRESETS, presetById } from '../../core/visual/visualPresets';
import { createRendererState, renderFrame } from '../../core/visual/canvasRenderer';
import { createWebGLVisualRenderer, type VisualRendererKind, type WebGLVisualRenderer } from '../../core/visual/webglRenderer';
import { IDLE_AUDIO_FEATURES, type AudioFeatures, type VisualParams } from '../../core/visual/types';
import { VISION_STYLES, suggestVisionStyle, type VisionStyle } from '../../core/ai/vision/visionPrompt';
import { useVisualShow } from '../../hooks/useVisualShow';

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

  // VISUAL-P1-005/P1-008: Renderer-Umschalter. Canvas2D bleibt die Referenz,
  // WebGL das Upgrade. Seit VISUAL-P1-008 zeichnet auch der GL-Pfad Show-Szenen
  // (Bild/Clip als Textur) — der Wechsel ist deshalb auch während einer Show möglich.
  const [rendererMode, setRendererMode] = useState<'canvas2d' | 'gl'>('canvas2d');
  const [rendererKind, setRendererKind] = useState<VisualRendererKind>('canvas2d');
  const glRendererRef = useRef<WebGLVisualRenderer | null>(null);

  // VisualMONK #5: Show-Orchestrator (Szenen aus Bildern/Clips, audio-reaktiv).
  // Über eine Ref erreichbar, damit die RAF-Schleife (Deps `[]`) ihn nutzen kann.
  const show = useVisualShow();
  const showRef = useRef(show);
  useEffect(() => { showRef.current = show; });

  // VisualMONK #2: generative Bilder (FLUX ueber /api/ai/vision).
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiStyle, setAiStyle] = useState<VisionStyle>('cosmic');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiImage, setAiImage] = useState<string | null>(null);
  const [aiImageUrl, setAiImageUrl] = useState<string | null>(null);
  const [aiError, setAiError] = useState('');
  /** AUTO: Prompt+Stil kommen aus dem laufenden Set (Feature-Bus). */
  const [aiAuto, setAiAuto] = useState(false);
  /**
   * RAG (Migration 008): vorgeschlagener Stil aus den bestbewerteten
   * Generierungen. Wird im AUTO-Modus bevorzugt, sonst gilt die Heuristik.
   */
  const [aiSuggestion, setAiSuggestion] = useState<{ style: VisionStyle; reason: string; source: string } | null>(null);
  /** Selbstlern-Loop: ID der letzten Generierung + Bewertung (Session-Ende). */
  const [aiGenerationId, setAiGenerationId] = useState<string | null>(null);
  const [aiRated, setAiRated] = useState(false);
  /** Video (Wan2.2 image->video) aus dem zuletzt generierten Bild. */
  const [aiVideo, setAiVideo] = useState<string | null>(null);
  const [aiVideoBusy, setAiVideoBusy] = useState(false);
  const [aiVideoError, setAiVideoError] = useState('');

  const generateAiVideo = useCallback(async () => {
    if (!aiImage || aiVideoBusy) return;
    setAiVideoBusy(true);
    setAiVideoError('');
    try {
      const resp = await fetch('/api/ai/vision/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: aiImage, prompt: aiPrompt.trim() || 'gentle camera push in, subtle motion', steps: 6 }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.status !== 'success' || !data?.video) {
        throw new Error(String(data?.message || data?.error || `HTTP ${resp.status}`));
      }
      setAiVideo(String(data.video));
    } catch (e) {
      setAiVideoError((e as Error).message.slice(0, 160));
    } finally {
      setAiVideoBusy(false);
    }
  }, [aiImage, aiPrompt, aiVideoBusy]);
  const featuresRef = useRef<AudioFeatures>(IDLE_AUDIO_FEATURES);

  const rateAi = useCallback(async (rating: number) => {
    if (!aiGenerationId) return;
    try {
      await fetch('/api/ai/vision/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationId: aiGenerationId, rating, keep: rating >= 3 }),
      });
      setAiRated(true);
    } catch { /* Bewertung ist optional */ }
  }, [aiGenerationId]);

  const generateAiImage = useCallback(async () => {
    if (aiBusy) return;
    const features = featuresRef.current;
    // Im AUTO-Modus darf der Prompt leer sein: Energie/Tempo/Stil kommen aus dem Set.
    const prompt = aiPrompt.trim() || (aiAuto ? 'live set visual' : '');
    if (!prompt) return;
    // AUTO: bevorzugt den gelernten (RAG-)Stil, sonst die Energie-/Tempo-Heuristik.
    const style = aiAuto
      ? (aiSuggestion ? aiSuggestion.style : suggestVisionStyle({ energy: features.energy, bpm: features.bpm }))
      : aiStyle;
    setAiBusy(true);
    setAiError('');
    try {
      const resp = await fetch('/api/ai/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          style,
          steps: 25,
          energy: features.energy,
          bpm: features.bpm || undefined,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.status !== 'success' || !data?.image) {
        throw new Error(String(data?.message || data?.error || `HTTP ${resp.status}`));
      }
      setAiImage(String(data.image));
      setAiImageUrl(typeof data.imageUrl === 'string' ? data.imageUrl : null);
      setAiGenerationId(typeof data.generationId === 'string' ? data.generationId : null);
      setAiRated(false);
    } catch (e) {
      setAiError((e as Error).message.slice(0, 160));
    } finally {
      setAiBusy(false);
    }
  }, [aiPrompt, aiStyle, aiAuto, aiBusy, aiSuggestion]);

  /**
   * RAG-Vorschlag holen (`GET /api/ai/vision/styles`): der Server liest die
   * bestbewerteten Stile aus `visual_style_ranking` (Migration 008). Ohne
   * Bewertungen kommt ehrlich der Heuristik-Vorschlag mit `source: 'fallback'`.
   */
  const suggestAiStyle = useCallback(async () => {
    const features = featuresRef.current;
    const params = new URLSearchParams();
    if (Number.isFinite(features.energy)) params.set('energy', String(features.energy));
    if (features.bpm > 0) params.set('bpm', String(Math.round(features.bpm)));
    try {
      const resp = await fetch(`/api/ai/vision/styles?${params.toString()}`);
      const data = await resp.json().catch(() => ({}));
      const s = data?.suggestion;
      if (!resp.ok || !s?.style) throw new Error(String(data?.error || `HTTP ${resp.status}`));
      const style = String(s.style);
      if (!VISION_STYLES.includes(style as VisionStyle)) {
        throw new Error(`unbekannter Stil aus dem Ranking: ${style.slice(0, 24)}`);
      }
      setAiStyle(style as VisionStyle);
      setAiSuggestion({
        style: style as VisionStyle,
        reason: String(s.reason ?? ''),
        source: String(s.source ?? ''),
      });
      setAiError('');
    } catch (e) {
      setAiError((e as Error).message.slice(0, 160));
    }
  }, []);

  // VisualMONK #5: aktuelles Bild/Clip als Show-Szene übernehmen.
  const addCurrentScene = useCallback(() => {
    const src = aiVideo ?? aiImage;
    if (!src) return;
    show.addScene({
      prompt: aiPrompt.trim() || 'live set visual',
      style: aiStyle,
      kind: aiVideo ? 'clip' : 'image',
      src,
      label: aiPrompt.trim() || aiStyle,
    });
  }, [aiImage, aiVideo, aiPrompt, aiStyle, show]);

  // VisualMONK #5: Text → Clip (FLUX-Bild → Wan2.2-Bewegung, ein Aufruf).
  const buildSceneClip = useCallback(() => {
    const features = featuresRef.current;
    const style = aiAuto ? suggestVisionStyle({ energy: features.energy, bpm: features.bpm }) : aiStyle;
    const prompt = aiPrompt.trim() || (aiAuto ? 'live set visual' : '');
    if (!prompt) return;
    void show.makeClip({ prompt, style, bpm: features.bpm || undefined, energy: features.energy });
  }, [aiAuto, aiPrompt, aiStyle, show]);

  // Auto-Show: alle 45 s ein neues Set-passendes Bild (kostenbewusst, nur wenn an).
  useEffect(() => {
    if (!aiAuto) return;
    const timer = window.setInterval(() => { void generateAiImage(); }, 45_000);
    return () => window.clearInterval(timer);
  }, [aiAuto, generateAiImage]);

  const toggleStream = useCallback(() => {
    if (streamStatus === 'live') {
      stopStream();
    } else {
      const stream = startStream(canvasRef.current, 30);
      const track = stream?.getVideoTracks()[0];
      if (track) {
        // An Ghostuser 6 senden (SFU-Producer bzw. P2P-Main-Stream).
        try { webRTCManager.publishVisualTrack(track); } catch { /* Transport nicht bereit */ }
      }
    }
  }, [streamStatus, startStream, stopStream]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Canvas2D ist der Referenzpfad; im GL-Modus gibt es keinen 2D-Kontext.
    const ctx = rendererMode === 'gl' ? null : canvas.getContext('2d');
    if (rendererMode === 'gl') {
      const gl = createWebGLVisualRenderer(canvas);
      glRendererRef.current = gl;
      setRendererKind(gl ? gl.kind : 'canvas2d');
      if (!gl) setAiError('WebGL nicht verfügbar – Canvas2D bleibt aktiv.');
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
      featuresRef.current = features;

      const preset = presetById(presetRef.current);
      // UI-P1-002: Reduced-Motion friert die Feldbewegung (kein Flackern/Drift).
      const animTimeS = reducedMotionRef.current ? 0 : now / 1000;
      const animDt = reducedMotionRef.current ? 0 : dt;
      // Reduced-Motion: keine Audio-Reaktivität/Glättung -> Parameter stehen still.
      const target = reducedMotionRef.current
        ? mapAudioToParams(IDLE_AUDIO_FEATURES, preset, 0)
        : mapAudioToParams(features, preset, animTimeS);
      // Reduced-Motion: ohne Glättungs-Animation direkt auf den Zielwert (Frames identisch).
      paramsRef.current = reducedMotionRef.current ? target : blendParams(paramsRef.current, target, 0.35);

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth || 960;
      const cssH = canvas.clientHeight || 540;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      // Show-Orchestrator: entscheidet den Szenenwechsel (Dauer/Beat/Energie).
      const showApi = showRef.current;
      showApi.tick(now, features);

      const gl = glRendererRef.current;
      if (gl) {
        gl.resize(canvas.width, canvas.height);
        // VISUAL-P1-008: Show-Szenen auch im GL-Pfad als Textur (kein drawImage).
        const scene = showApi.playing ? showApi.frame() : null;
        gl.render(preset, paramsRef.current, animTimeS, scene);
      } else if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderFrame(ctx, cssW, cssH, preset, paramsRef.current, stateRef.current, animDt);
        // Canvas2D: Szene per drawImage über die Visualisierung (Crossfade).
        if (showApi.playing) showApi.draw(ctx, cssW, cssH);
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
  }, [rendererMode]);

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
      aria-label="VisualMONK Liveshow"
      data-renderer={rendererKind}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <span className="text-[10px] font-bold tracking-widest text-fuchsia-300">VISUALMONK · LIVESHOW</span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${audioLinked ? 'border-emerald-400/50 text-emerald-300' : 'border-neutral-600 text-neutral-400'}`}>
          {audioLinked ? 'AUDIO LIVE' : 'wartet auf Wiedergabe'}
        </span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${streamStatus === 'live' ? 'border-cyan-400/60 text-cyan-300' : streamStatus === 'unsupported' ? 'border-amber-400/50 text-amber-300' : 'border-neutral-700 text-neutral-400'}`}>
          {streamStatus === 'live' ? 'GHOSTUSER 6 · STREAM AN' : streamStatus === 'unsupported' ? 'Stream nicht unterstützt' : 'Stream aus'}
        </span>
        <span
          className={`text-[9px] px-1.5 py-0.5 rounded-full border ${rendererKind === 'canvas2d' ? 'border-neutral-700 text-neutral-400' : 'border-emerald-400/50 text-emerald-300'}`}
          title={rendererMode === 'gl' && rendererKind === 'canvas2d' ? 'WebGL nicht verfügbar – Canvas2D aktiv' : `Renderer: ${rendererKind}`}
        >
          {rendererKind.toUpperCase()}
        </span>
        <button
          type="button"
          onClick={() => setRendererMode((m) => (m === 'gl' ? 'canvas2d' : 'gl'))}
          aria-pressed={rendererMode === 'gl'}
          title="Renderer wechseln: WebGL (GPU-Renderer) oder Canvas2D (Referenz) – auch während einer laufenden Show (VISUAL-P1-008)"
          className={`px-2 py-1 rounded-full text-[9px] font-bold tracking-widest border transition-colors ${rendererMode === 'gl' ? 'border-emerald-400/60 text-emerald-200 bg-emerald-400/10' : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}
        >
          {rendererMode === 'gl' ? 'WEBGL' : 'CANVAS2D'}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={toggleStream}
          className="px-3 py-1.5 rounded-full text-[10px] font-bold tracking-widest border border-cyan-400/50 text-cyan-200 hover:bg-cyan-400/10 transition-colors"
          aria-pressed={streamStatus === 'live'}
        >
          {streamStatus === 'live' ? 'STREAM AUS' : 'AN GHOSTUSER 6'}
        </button>
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

      {/* VisualMONK #2: generatives Bild (FLUX ueber /api/ai/vision) */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-white/5">
        <input
          value={aiPrompt}
          onChange={(e) => setAiPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void generateAiImage(); }}
          placeholder="Bild-Prompt (z. B. Galaxie ueber dunklem Wasser, Filmkorn)"
          aria-label="Bild-Prompt"
          className="flex-1 min-w-[12rem] px-2.5 py-1.5 rounded-full bg-black/40 border border-white/10 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-fuchsia-400/60"
        />
        <select
          value={aiStyle}
          onChange={(e) => setAiStyle(e.target.value as VisionStyle)}
          aria-label="Bild-Stil"
          className="px-2 py-1.5 rounded-full bg-neutral-900 border border-neutral-700 text-[10px] text-neutral-300 focus:outline-none"
        >
          {VISION_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button
          type="button"
          onClick={() => setAiAuto((v) => !v)}
          aria-pressed={aiAuto}
          title="AUTO: Prompt/Stil kommen aus dem laufenden Set (Energie/Tempo), alle 45 s ein neues Bild"
          className={`px-2.5 py-1.5 rounded-full text-[10px] font-bold tracking-widest border transition-colors ${aiAuto ? 'border-emerald-400/70 text-emerald-200 bg-emerald-400/10' : 'border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}
        >
          AUTO {aiAuto ? 'AN' : 'AUS'}
        </button>
        <button
          type="button"
          onClick={() => void suggestAiStyle()}
          title="RAG-Vorschlag: Stil aus den bestbewerteten Generierungen holen (visual_style_ranking, Migration 008)"
          className="px-2.5 py-1.5 rounded-full text-[10px] font-bold tracking-widest border border-amber-400/50 text-amber-200 hover:bg-amber-400/10 transition-colors"
        >
          VORSCHLAG
        </button>
        {aiSuggestion && (
          <span className="text-[9px] text-amber-300/90" title={aiSuggestion.reason}>
            {aiSuggestion.source === 'ranking' ? 'GELERNT' : 'HEURISTIK'}: {aiSuggestion.style}
            {aiSuggestion.reason ? ` · ${aiSuggestion.reason}` : ''}
          </span>
        )}
        <button
          type="button"
          onClick={() => void generateAiImage()}
          disabled={aiBusy || (!aiPrompt.trim() && !aiAuto)}
          className="px-3 py-1.5 rounded-full text-[10px] font-bold tracking-widest border border-fuchsia-400/50 text-fuchsia-200 hover:bg-fuchsia-400/10 disabled:opacity-40 transition-colors"
        >
          {aiBusy ? 'ERZEUGT… (kalt ~40 s)' : 'BILD ERZEUGEN'}
        </button>
        <button
          type="button"
          onClick={() => void generateAiVideo()}
          disabled={!aiImage || aiVideoBusy}
          title="Aus dem Bild einen kurzen Clip machen (Wan2.2 image->video)"
          className="px-3 py-1.5 rounded-full text-[10px] font-bold tracking-widest border border-cyan-400/50 text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-40 transition-colors"
        >
          {aiVideoBusy ? 'VIDEO… (~2 min)' : 'VIDEO'}
        </button>
        {aiVideoError && <span className="text-[10px] text-red-400">{aiVideoError}</span>}
        {aiError && <span className="text-[10px] text-red-400">{aiError}</span>}
        {aiImageUrl && (
          <a href={aiImageUrl} target="_blank" rel="noreferrer" className="text-[10px] text-cyan-300 underline">R2-Link</a>
        )}
      </div>

      {/* VisualMONK #5: Show – Szenen aus Bildern/Clips, audio-reaktiver Ablauf */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-white/5">
        <span className="text-[9px] font-bold tracking-widest text-cyan-300">SHOW</span>
        <button
          type="button"
          onClick={addCurrentScene}
          disabled={!aiImage && !aiVideo}
          title="Aktuelles Bild oder Clip als Szene in die Show übernehmen"
          className="px-2.5 py-1.5 rounded-full text-[10px] font-bold tracking-widest border border-cyan-400/50 text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-40 transition-colors"
        >
          SZENE +
        </button>
        <button
          type="button"
          onClick={buildSceneClip}
          disabled={Boolean(show.busy) || (!aiPrompt.trim() && !aiAuto)}
          title="Text zu Clip: FLUX-Bild, dann Wan2.2-Bewegung (ein Aufruf)"
          className="px-2.5 py-1.5 rounded-full text-[10px] font-bold tracking-widest border border-fuchsia-400/50 text-fuchsia-200 hover:bg-fuchsia-400/10 disabled:opacity-40 transition-colors"
        >
          CLIP AUS TEXT
        </button>
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
            onClick={show.clearShow}
            title="Show leeren (Medien bleiben generiert)"
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
        {show.lastStore && <span className="text-[9px] text-neutral-500">Ablage: {show.lastStore}</span>}
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
        <canvas key={rendererMode} ref={canvasRef} className="w-full h-full block" />
        {aiImage && (
          <img
            src={aiImage}
            alt="KI-generiertes Bild"
            className="absolute right-3 bottom-3 w-56 max-h-[45%] object-cover rounded-lg border border-white/20 shadow-2xl"
          />
        )}
        {aiVideo && (
          <video
            src={aiVideo}
            controls
            autoPlay
            loop
            muted
            className="absolute left-3 bottom-3 w-56 max-h-[45%] rounded-lg border border-cyan-400/40 shadow-2xl bg-black"
          />
        )}
        {aiImage && aiGenerationId && (
          <div className="absolute right-3 bottom-3 translate-y-[calc(100%+0.5rem)] flex items-center gap-1 px-2 py-1 rounded-full bg-black/70 border border-white/10">
            <span className="text-[9px] tracking-widest text-neutral-400 mr-1">BEWERTEN</span>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => void rateAi(n)}
                title={`${n} von 5`}
                className="w-6 h-6 rounded-full text-[10px] font-bold border border-amber-400/40 text-amber-200 hover:bg-amber-400/20 transition-colors"
              >
                {n}
              </button>
            ))}
            {aiRated && <span className="text-[9px] text-emerald-300 ml-1">DANKE</span>}
          </div>
        )}
      </div>
    </div>
  );
};
