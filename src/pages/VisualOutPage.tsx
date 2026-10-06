import { useEffect, useRef, useState } from 'react';
import { Monitor, Sparkles } from 'lucide-react';
import { webRTCManager } from '../utils/WebRTCManager';
import { SESSION_MODE_LABEL } from '../core/session/listenerMode';
import { mjpegStreamUrl, studioTokenFromCookie } from '../utils/visualMjpeg';

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

function readScreen(): { width: number; height: number; devicePixelRatio: number } {
  return {
    width: window.screen?.width || window.innerWidth,
    height: window.screen?.height || window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

export const VisualOutPage = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'connecting' | 'waiting' | 'live' | 'error'>('connecting');
  const [activated, setActivated] = useState(false);
  const [error, setError] = useState('');
  /** Ein anderes Gerät ist jetzt der Main-Ausgang Bild (es gibt genau einen). */
  const [replaced, setReplaced] = useState(false);
  useEffect(() => webRTCManager.onOutputReplaced(() => setReplaced(true)), []);
  /**
   * VISUAL-P1-001: MJPEG-Fallback. Der Spec-Punkt „Fallback ohne SFU" war nie
   * gebaut - genau er traegt den Beamer, wenn WebRTC/SFU nicht durchkommt (kein
   * Login, kein Signaling, fremdes Geraet). Der Fallback ist KEIN Ersatz: er
   * springt nur ein, wenn der WebRTC-Stream nicht kommt.
   */
  const [mjpeg, setMjpeg] = useState(false);
  const [mjpegError, setMjpegError] = useState(false);
  /** Stream-Auflösung: was ankommt (Video) und was dieser Bildschirm kann. */
  const [incoming, setIncoming] = useState<{ width: number; height: number } | null>(null);

  // Main-Ausgang Bild (Betreiber 2026-10-06): Der Beamer meldet Bildschirm,
  // Zustand und ankommende Stream-Auflösung (Session-Ausgänge). Steht der Sender
  // auf „Auto", rendert er den Stream genau in dieser Auflösung – unabhängig
  // davon, ob er selbst auf Handy, Pad oder PC sendet.
  const [display, setDisplay] = useState(() => readScreen());
  useEffect(() => {
    const update = () => setDisplay(readScreen());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  useEffect(() => {
    webRTCManager.sendEndpointReport({
      ...display,
      state,
      streamWidth: incoming?.width ?? 0,
      streamHeight: incoming?.height ?? 0,
    });
  }, [display, state, incoming]);
  const screenPx = `${Math.round(display.width * display.devicePixelRatio)}×${Math.round(display.height * display.devicePixelRatio)}`;

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
    // Ohne Video-Track nach 6 s auf MJPEG umschalten (Beamer-Notfallpfad).
    const fallbackTimer = window.setTimeout(() => setState((prev) => {
      if (prev !== 'live') setMjpeg(true);
      return prev;
    }), 6000);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(fallbackTimer);
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
      {replaced && (
        <div role="alert" data-testid="output-replaced" className="absolute inset-x-0 top-0 z-50 bg-amber-500/90 text-black text-center text-xs font-bold tracking-widest px-4 py-3">
          Ein anderes Gerät ist jetzt der Main-Ausgang Bild. Dieses Gerät ist getrennt – zum Zurückholen Seite neu laden.
        </div>
      )}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        onResize={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setIncoming({ width: v.videoWidth, height: v.videoHeight });
        }}
        className="absolute inset-0 w-full h-full object-contain bg-black"
      />

      {/* MJPEG-Fallback: reines <img> gegen den Server-Strom (kein SFU, kein Login) */}
      {mjpeg && state !== 'live' && !mjpegError && (
        <img
          src={mjpegStreamUrl(studioTokenFromCookie())}
          alt="Visual-Fallback (MJPEG)"
          className="absolute inset-0 w-full h-full object-contain bg-black"
          onLoad={() => { setState('live'); setMjpegError(false); }}
          onError={() => setMjpegError(true)}
        />
      )}

      {/* Status-Overlay (nur solange nicht live) */}
      {state !== 'live' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/80">
          <div className="flex items-center gap-4">
            <div className={`w-3 h-3 rounded-full ${state === 'error' ? 'bg-red-500' : 'bg-amber-400 animate-pulse'}`} />
            <h1 className="text-2xl font-black tracking-[0.35em] text-neutral-100">VISUAL OUT</h1>
            <span className="text-[10px] font-mono tracking-[0.3em] text-neutral-500">GHOSTUSER 6 · BEAMER</span>
          </div>
          <p className="text-xs font-mono tracking-widest text-neutral-400">
            {/* In diesem Block ist `state` bereits nicht 'live' (TS-Narrowing). */}
            {mjpeg && !mjpegError && 'WebRTC kommt nicht durch – MJPEG-Fallback aktiv …'}
            {mjpegError && 'Weder WebRTC noch MJPEG-Fallback erreichbar.'}
            {!mjpeg && state === 'connecting' && 'Verbinde mit Studio-Session …'}
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
          {incoming && <span data-testid="visual-out-resolution">· {incoming.width}×{incoming.height}</span>}
        </div>
      )}

      <div className="absolute bottom-4 left-4 flex items-center gap-2 text-neutral-600 text-[10px] font-mono tracking-widest">
        <Sparkles className="w-3 h-3" />
        {SESSION_MODE_LABEL['visual-out']} · /visual-out · /ghost/6
        {screenPx && <span data-testid="visual-out-screen">· Bildschirm {screenPx}</span>}
      </div>
    </div>
  );
};
