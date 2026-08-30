import { useCallback, useEffect, useRef, useState } from 'react';
import { audioEngine } from '../utils/audioEngine';
import { webRTCManager } from '../utils/WebRTCManager';
import { sfuTransport } from '../core/transport/MediasoupTransport';

export type MasterStreamStatus = 'off' | 'starting' | 'live' | 'live-local' | 'error';

/**
 * useMasterStream – Master-Audio als MediaStream (SFU/Lokal).
 * ----------------------------------------------------------
 * ON:  erzeugt eine MediaStream-Destination am Master-Ausgang der Audio-
 *      Engine. Läuft die Session im SFU-Modus, wird der Track als Producer
 *      an die SFU gesendet; sonst bleibt der Stream lokal (Monitoring).
 * OFF: trennt Destination und stoppt den Track.
 */
export const useMasterStream = () => {
  const [status, setStatus] = useState<MasterStreamStatus>('off');
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);

  const stop = useCallback(() => {
    const track = trackRef.current;
    if (track) {
      try { track.stop(); } catch { /* bereits gestoppt */ }
      trackRef.current = null;
    }
    if (destRef.current) {
      audioEngine.disconnectMasterStreamDestination(destRef.current);
      destRef.current = null;
    }
    setStatus('off');
  }, []);

  const start = useCallback(async () => {
    if (status === 'starting' || status === 'live' || status === 'live-local') return;
    setStatus('starting');
    try {
      await audioEngine.init();
      const dest = audioEngine.createMasterStreamDestination();
      if (!dest) {
        setStatus('error');
        return;
      }
      destRef.current = dest;
      const track = dest.stream.getAudioTracks()[0];
      trackRef.current = track ?? null;

      if (webRTCManager.isSfuMode && track) {
        try {
          await sfuTransport.sendAudioTrack(track);
          setStatus('live');
          return;
        } catch {
          // SFU nicht erreichbar → Stream bleibt lokal hörbar/aufnehmbar.
        }
      }
      setStatus('live-local');
    } catch {
      setStatus('error');
    }
  }, [status]);

  useEffect(() => stop, [stop]);

  return { status, start, stop };
};
