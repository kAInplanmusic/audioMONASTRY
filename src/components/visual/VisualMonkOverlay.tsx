import React, { useCallback, useEffect, useRef, useState } from 'react';
import { audioEngine } from '../../utils/audioEngine';
import { useVisualStream } from '../../hooks/useVisualStream';
import { VisualFeatureBus } from '../../core/visual/featureBus';
import { mapAudioToParams, blendParams } from '../../core/visual/audioReactive';
import { VISUAL_PRESETS, presetById } from '../../core/visual/visualPresets';
import { createRendererState, renderFrame } from '../../core/visual/canvasRenderer';
import { IDLE_AUDIO_FEATURES, type AudioFeatures, type VisualParams } from '../../core/visual/types';

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
  const [presetId, setPresetId] = useState<string>(VISUAL_PRESETS[0].id);
  const [audioLinked, setAudioLinked] = useState(false);
  const presetRef = useRef(presetId);
  useEffect(() => { presetRef.current = presetId; }, [presetId]);
  const { status: streamStatus, start: startStream, stop: stopStream } = useVisualStream();

  const toggleStream = useCallback(() => {
    if (streamStatus === 'live') {
      stopStream();
    } else {
      startStream(canvasRef.current, 30);
    }
  }, [streamStatus, startStream, stopStream]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

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
          busRef.current = new VisualFeatureBus(analyser);
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
      const target = mapAudioToParams(features, preset, now / 1000);
      paramsRef.current = blendParams(paramsRef.current, target, 0.35);

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = canvas.clientWidth || 960;
      const cssH = canvas.clientHeight || 540;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderFrame(ctx, cssW, cssH, preset, paramsRef.current, stateRef.current, dt);

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      disposed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (analyserRef.current) {
        try { audioEngine.disconnectVisualAnalyser(analyserRef.current); } catch { /* ignore */ }
        analyserRef.current = null;
        busRef.current = null;
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[80] bg-black/95 backdrop-blur-sm flex flex-col" role="dialog" aria-label="VisualMONK Liveshow">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <span className="text-[10px] font-bold tracking-widest text-fuchsia-300">VISUALMONK · LIVESHOW</span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${audioLinked ? 'border-emerald-400/50 text-emerald-300' : 'border-neutral-600 text-neutral-400'}`}>
          {audioLinked ? 'AUDIO LIVE' : 'wartet auf Wiedergabe'}
        </span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${streamStatus === 'live' ? 'border-cyan-400/60 text-cyan-300' : streamStatus === 'unsupported' ? 'border-amber-400/50 text-amber-300' : 'border-neutral-700 text-neutral-400'}`}>
          {streamStatus === 'live' ? 'GHOSTUSER 6 · STREAM AN' : streamStatus === 'unsupported' ? 'Stream nicht unterstützt' : 'Stream aus'}
        </span>
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

      <div className="flex-1 min-h-0">
        <canvas ref={canvasRef} className="w-full h-full block" />
      </div>
    </div>
  );
};
