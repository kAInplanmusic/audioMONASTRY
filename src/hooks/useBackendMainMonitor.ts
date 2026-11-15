import { useEffect, useRef, useState } from 'react';
import { BackendMainPlayback, connectBackendMain } from '../core/transport/backendMainClient';
import { webRTCManager } from '../utils/WebRTCManager';

export type BackendMonitorStatus = 'off' | 'connecting' | 'playing' | 'error';

/** R16 §P2: who is allowed to hear the finished backend Main over the monitor path. */
export function shouldUseBackendMainMonitor(input: {
  userId: string; mixerHolder: string; masterHolder: string; routing: 'main' | 'plugins' | 'cue';
}): boolean {
  const holdsMixer = !!input.mixerHolder && input.userId === input.mixerHolder;
  const holdsMaster = !!input.masterHolder && input.userId === input.masterHolder;
  return input.routing === 'main' && (holdsMixer || holdsMaster);
}

/**
 * Listens to the finished backend Main (mastering included). There is deliberately no
 * local fallback: if the ticket is refused or the stream breaks, the status is 'error'
 * and the caller shows it.
 */
export function useBackendMainMonitor(enabled: boolean): { status: BackendMonitorStatus; error: string } {
  const [status, setStatus] = useState<BackendMonitorStatus>('off');
  const [error, setError] = useState('');
  const playbackRef = useRef<BackendMainPlayback | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const playback = new BackendMainPlayback();
    playbackRef.current = playback;
    let socket: WebSocket | null = null;
    void (async () => {
      setStatus('connecting'); setError('');
      try {
        const ticket = await webRTCManager.requestBackendMainTicket('monitor');
        if (cancelled) return;
        socket = connectBackendMain(ticket, {
          ready: async (format) => {
            try { await playback.activate(format.sampleRate); if (!cancelled) setStatus('playing'); }
            catch (err) { if (!cancelled) { setError(err instanceof Error ? err.message : 'Main monitor failed'); setStatus('error'); } }
          },
          chunk: async (metadata, payload) => { await playback.play(metadata, payload); },
          error: (err) => { if (!cancelled) { setError(err.message); setStatus('error'); } },
        }, url => new WebSocket(url));
      } catch (err) {
        if (!cancelled) { setError(err instanceof Error ? err.message : 'Main monitor access denied'); setStatus('error'); }
      }
    })();
    return () => {
      cancelled = true;
      try { socket?.close(); } catch { /* already closed */ }
      void playback.close();
      playbackRef.current = null;
    };
  }, [enabled]);

  return { status: enabled ? status : 'off', error };
}
