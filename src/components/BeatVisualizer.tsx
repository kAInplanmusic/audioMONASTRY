import React, { useEffect, useRef } from 'react';

import { audioEngine } from '../utils/audioEngine';
import { createVisualizerWorker } from '../utils/workerFactory';

interface BeatVisualizerProps {
  isPlaying: boolean;
}

export const BeatVisualizer: React.FC<BeatVisualizerProps> = React.memo(({ isPlaying }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // WICHTIG: React StrictMode ruft diesen Effekt doppelt auf. Ein zweites
    // `transferControlToOffscreen()` auf demselben Canvas wirft die DOMException
    // "An attempt was made to use an object that is not, or is no longer,
    // usable" und crasht damit den App-Mount (SafeModuleBoundary-Fallback).
    // Daher übertragen wir das Canvas nur EINMAL und fangen Fehler ab.
    let offscreen: OffscreenCanvas | null = null;
    try {
      // transferControlToOffscreen ist DOM-typisiert; Fehler werden via try/catch abgefangen.
      offscreen = canvas.transferControlToOffscreen() as unknown as OffscreenCanvas | null;
    } catch (e) {
      console.warn('BeatVisualizer: Canvas nicht übertragbar (bereits detached) – Fallback auf leeren Worker.', e);
      offscreen = null;
    }

    try {
      workerRef.current = createVisualizerWorker();
    } catch (e) {
      console.warn('BeatVisualizer: Worker nicht erstellbar – Visualizer deaktiviert.', e);
      workerRef.current = null;
    }
    if (!workerRef.current) return;

    // Get SAB from audioEngine if available (heuristisch nur übergeben, wenn es
    // wirklich nutzbar ist – ein defekter/abgebrochener Buffer würde sonst beim
    // postMessage-Transfer eine DOMException auslösen).
    let sab: ArrayBufferLike | null = null;
    try {
      if (audioEngine.initialized && audioEngine.sharedWaveformBuffer &&
          audioEngine.sharedWaveformBuffer.byteLength > 0) {
        sab = audioEngine.sharedWaveformBuffer.buffer;
      }
    } catch { /* SAB nicht verfügbar */ }

    try {
      const transfer: Transferable[] = sab && offscreen ? [offscreen, sab as ArrayBuffer] : [offscreen as Transferable];
      workerRef.current.postMessage({ 
        type: 'init', 
        canvas: offscreen, 
        sab,
        width: 800, // Fixed resolution
        height: 200,
        playing: isPlaying
      }, transfer);
    } catch (e) {
      console.warn('BeatVisualizer: Worker-Init fehlgeschlagen (visualizer wird übersprungen).', e);
    }

    return () => {
      workerRef.current?.terminate();
    };
// eslint-disable-next-line react-hooks/exhaustive-deps -- bewusst beibehalten (Runde 3, Hook-Deps werden separat auditiert)
  }, []);

  // Sync playing state with worker
  useEffect(() => {
    workerRef.current?.postMessage({
        type: 'state',
        playing: isPlaying
    });
  }, [isPlaying]);

  return (
    <div id="visualizer-container" className="w-full h-28 short-landscape:h-16 bg-[#09090b] rounded-xl overflow-hidden border border-neutral-800/80 relative">
      <canvas
        id="audio-visual-canvas"
        ref={canvasRef}
        width={800}
        height={200}
        className="w-full h-full block"
      />
      <div className="absolute top-2 left-3 bg-black/60 px-2 py-0.5 rounded text-[10px] font-mono text-neutral-400 border border-neutral-800 tracking-wider uppercase select-none">
        {isPlaying ? 'FREQUENCY WAVEFORM // LIVE' : 'STATION IDLE'}
      </div>
    </div>
  );
});
