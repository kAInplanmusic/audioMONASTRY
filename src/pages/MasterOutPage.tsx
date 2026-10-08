import { useEffect, useRef, useState } from 'react';
import { Radio, Volume2 } from 'lucide-react';
import { webRTCManager } from '../utils/WebRTCManager';

/**
 * MASTEROUTMAINSTREAM – eigene Seite (/master-out)
 * ================================================
 * Gibt AUSSCHLIESSLICH das Main-Signal des Session-Hosts aus – für den
 * Laptop, der per Web an die PA/den Verstärker geht.
 *
 * Szenario: 4 iPads (Session-User) + 1 Laptop (/master-out am Verstärker).
 * Der Listener zählt NICHT zu den 4 Session-Usern (server-seitiger
 * `master-out`-Modus) und verbindet sich nur mit dem Host.
 */
// Der Listener-Modus kommt aus der Andock-URL (sessionMode() -> listenerModeForPath);
// ein Modul-Seiteneffekt war hier falsch, weil main.tsx beide Seiten eager importiert.

export const MasterOutPage = () => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<'connecting' | 'waiting' | 'live' | 'error'>('connecting');
  const [activated, setActivated] = useState(false);
  const [error, setError] = useState('');
  /** Diese Adresse ist schon von einem anderen Gerät belegt (es gibt genau einen Main-Ausgang Audio). */
  const [busy, setBusy] = useState(false);
  useEffect(() => webRTCManager.onOutputBusy(() => setBusy(true)), []);
  /** Format des ankommenden Main-Tons (aus den Track-Einstellungen, soweit der Browser sie nennt). */
  const [format, setFormat] = useState({ sampleRate: 0, channels: 0 });

  // Main-Ausgang Ton (Betreiber 2026-10-06): die PA meldet Zustand und Format
  // an die Session (Session-Ausgänge) – sichtbar im Ausgänge-Panel aller Nutzer.
  useEffect(() => {
    webRTCManager.sendEndpointReport({ state, sampleRate: format.sampleRate, channels: format.channels });
  }, [state, format]);

  useEffect(() => {
    const readFormat = (stream: MediaStream) => {
      const settings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
      setFormat({ sampleRate: Number(settings.sampleRate) || 0, channels: Number(settings.channelCount) || 0 });
    };
    webRTCManager.onRemoteStream = (stream) => {
      readFormat(stream);
      if (audioRef.current) {
        audioRef.current.srcObject = stream;
        void audioRef.current.play().then(() => setState('live')).catch(() => {
          // Autoplay-Policy: Warten auf den Aktivieren-Button.
          setState((prev) => (prev === 'live' ? prev : 'waiting'));
        });
      }
    };
    webRTCManager.onSessionUpdate = (info) => {
      if (info.joined && !webRTCManager.isMasterOutMode) setState('error');
    };
    webRTCManager.onMainStream = (stream) => {
      readFormat(stream);
      if (audioRef.current) {
        audioRef.current.srcObject = stream;
        void audioRef.current.play().then(() => setState('live')).catch(() => setState('waiting'));
      }
    };
    // Socket-Fehler sichtbar machen.
    const t = setInterval(() => {
      if (state !== 'live') {
        setError('');
      }
    }, 0);
    clearInterval(t);
    return () => {
      webRTCManager.onRemoteStream = () => {};
      webRTCManager.onMainStream = () => {};
    };
  }, [state]);

  const activate = () => {
    setActivated(true);
    if (audioRef.current?.srcObject) {
      void audioRef.current.play().then(() => setState('live')).catch(() => setError('Audio-Ausgabe blockiert – Browser-Einstellung prüfen.'));
    } else {
      // Noch kein Main-Signal – Seite bleibt im Wartezustand und spielt,
      // sobald der Host-Stream eintrifft (audio.autoplay greift nach Geste).
      setState('waiting');
    }
  };

  return (
    <div className="fixed inset-0 bg-black text-white flex flex-col items-center justify-center gap-6 select-none overflow-hidden">
      {busy && (
        <div role="alert" data-testid="output-busy" className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 px-6 text-center">
          <p className="max-w-md text-sm font-bold tracking-wide text-amber-200">
            Der Main-Ausgang Audio ist schon auf einem anderen Gerät geöffnet. Es gibt genau einen.
            Dort schließen, dann diese Seite neu laden.
          </p>
        </div>
      )}
      <audio ref={audioRef} autoPlay playsInline className="hidden" />

      {/* Status-Kopf */}
      <div className="flex items-center gap-4">
        <div className={`w-3 h-3 rounded-full ${state === 'live' ? 'bg-emerald-400 animate-pulse' : state === 'error' ? 'bg-red-500' : 'bg-amber-400 animate-pulse'}`} />
        <h1 className="text-2xl font-black tracking-[0.35em] text-neutral-100">MASTER OUT</h1>
        <span className="text-[10px] font-mono tracking-[0.3em] text-neutral-500">MAIN SIGNAL</span>
      </div>

      {/* Statuszeile */}
      <p className="text-xs font-mono tracking-widest text-neutral-400">
        {state === 'connecting' && 'Verbinde mit Studio-Session …'}
        {state === 'waiting' && 'Verbunden – warte auf Main-Signal des Hosts …'}
        {state === 'live' && 'MAIN LIVE – Ausgabe läuft'}
        {state === 'error' && 'Verbindungsfehler – Seite neu laden'}
      </p>

      {/* Aktivieren-Button (Autoplay-Policy) */}
      {!activated && (
        <button
          type="button"
          onClick={activate}
          className="mt-4 px-8 py-4 rounded-full border border-cyan-400/60 bg-cyan-500/10 text-cyan-200 text-sm font-black tracking-[0.3em] uppercase hover:bg-cyan-500/20 hover:border-cyan-300/80 transition-all active:scale-95 cursor-pointer"
        >
          <Volume2 className="inline w-4 h-4 mr-2" />
          Main-Ausgabe aktivieren
        </button>
      )}

      {error && <p className="text-red-400 text-xs font-mono">{error}</p>}

      {/* Fußzeile */}
      <div className="absolute bottom-6 flex items-center gap-2 text-neutral-600 text-[10px] font-mono tracking-widest">
        <Radio className="w-3 h-3" />
        MASTEROUTMAINSTREAM · /master-out · 4 iPads + 1 Laptop (PA)
      </div>
    </div>
  );
};
