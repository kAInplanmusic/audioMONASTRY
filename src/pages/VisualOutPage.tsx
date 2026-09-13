import { useEffect, useRef, useState } from 'react';
import { Monitor, Sparkles } from 'lucide-react';
import { webRTCManager } from '../utils/WebRTCManager';
import { SESSION_MODE_LABEL } from '../core/session/listenerMode';

/**
 * VISUALOUTMAINSTREAM – eigene Seite (/visual-out) = **Ghostuser 6**
 * =================================================================
 * Gibt AUSSCHLIESSLICH den Visualisierungs-Stream des Hosts aus – für den
 * Beamer/Projektor. Der Listener zählt NICHT zu den 4 Session-Usern
 * (server-seitiger `visual-out`-Modus) und verbindet sich nur mit dem Host.
 *
 * Andock-URLs: `/visual-out` oder `/ghost/6`.
 */
// Der Listener-Modus kommt aus der Andock-URL (sessionMode() -> listenerModeForPath);
// ein Modul-Seiteneffekt war hier falsch, weil main.tsx beide Seiten eager importiert.

export const VisualOutPage = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'connecting' | 'waiting' | 'live' | 'error'>('connecting');
  const [activated, setActivated] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const attach = (stream: MediaStream) => {
      const video = videoRef.current;
      if (!video) return;
      const track = stream.getVideoTracks()[0];
      if (!track) return; // nur Audio eingetroffen → weiter warten
      video.srcObject = new MediaStream([track]);
      void video.play().then(() => setState('live')).catch(() => setState('waiting'));
    };

    webRTCManager.onRemoteStream = (stream) => attach(stream);
    webRTCManager.onMainStream = (stream) => attach(stream);
    webRTCManager.onSessionUpdate = (info) => {
      if (info.joined && !webRTCManager.isVisualOutMode) setState('error');
    };

    const t = window.setTimeout(() => setState((prev) => (prev === 'connecting' ? 'waiting' : prev)), 4000);
    return () => {
      window.clearTimeout(t);
      webRTCManager.onRemoteStream = () => {};
      webRTCManager.onMainStream = () => {};
    };
  }, []);

  const activate = () => {
    setActivated(true);
    if (videoRef.current?.srcObject) {
      void videoRef.current.play().then(() => setState('live')).catch(() => setError('Video-Ausgabe blockiert – Browser-Einstellung prüfen.'));
    } else {
      setState('waiting');
    }
  };

  return (
    <div className="fixed inset-0 bg-black text-white select-none overflow-hidden">
      <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-contain bg-black" />

      {/* Status-Overlay (nur solange nicht live) */}
      {state !== 'live' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/80">
          <div className="flex items-center gap-4">
            <div className={`w-3 h-3 rounded-full ${state === 'error' ? 'bg-red-500' : 'bg-amber-400 animate-pulse'}`} />
            <h1 className="text-2xl font-black tracking-[0.35em] text-neutral-100">VISUAL OUT</h1>
            <span className="text-[10px] font-mono tracking-[0.3em] text-neutral-500">GHOSTUSER 6 · BEAMER</span>
          </div>
          <p className="text-xs font-mono tracking-widest text-neutral-400">
            {state === 'connecting' && 'Verbinde mit Studio-Session …'}
            {state === 'waiting' && 'Verbunden – warte auf Visual-Stream des Hosts … (Studio: VISUAL → AN GHOSTUSER 6)'}
            {state === 'error' && 'Verbindungsfehler – Seite neu laden'}
          </p>
          {!activated && (
            <button
              type="button"
              onClick={activate}
              className="mt-2 px-8 py-4 rounded-full border border-fuchsia-400/60 bg-fuchsia-500/10 text-fuchsia-200 text-sm font-black tracking-[0.3em] uppercase hover:bg-fuchsia-500/20 hover:border-fuchsia-300/80 transition-all active:scale-95 cursor-pointer"
            >
              <Sparkles className="inline w-4 h-4 mr-2" />
              Visual-Ausgabe aktivieren
            </button>
          )}
          {error && <p className="text-red-400 text-xs font-mono">{error}</p>}
        </div>
      )}

      {/* Kleiner Live-Badge, damit man den Zustand auch auf dem Beamer sieht */}
      {state === 'live' && (
        <div className="absolute bottom-4 right-4 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/50 border border-white/10 text-[10px] font-mono tracking-widest text-neutral-300">
          <Monitor className="w-3 h-3" /> LIVE
        </div>
      )}

      <div className="absolute bottom-4 left-4 flex items-center gap-2 text-neutral-600 text-[10px] font-mono tracking-widest">
        <Sparkles className="w-3 h-3" />
        {SESSION_MODE_LABEL['visual-out']} · /visual-out · /ghost/6
      </div>
    </div>
  );
};
