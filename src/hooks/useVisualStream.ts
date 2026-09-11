import { useCallback, useEffect, useRef, useState } from 'react';

export type VisualStreamStatus = 'off' | 'live' | 'unsupported';

/**
 * VisualMONK – Canvas als MediaStream für **Ghostuser 6** (Beamer).
 *
 * `canvas.captureStream(fps)` liefert einen echten MediaStream-Track, der wie
 * der Master-Sound-Track über den bestehenden WebRTC/SFU-Pfad an den
 * Ghost-Client gehen kann. Ohne `captureStream` (ältere Browser) wird
 * ausdrücklich `unsupported` gemeldet statt eines stillen Nicht-Streams.
 */
export const useVisualStream = () => {
  const [status, setStatus] = useState<VisualStreamStatus>('off');
  const streamRef = useRef<MediaStream | null>(null);

  const start = useCallback((canvas: HTMLCanvasElement | null, fps = 30): MediaStream | null => {
    if (!canvas || typeof canvas.captureStream !== 'function') {
      setStatus('unsupported');
      return null;
    }
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const stream = canvas.captureStream(fps);
      streamRef.current = stream;
      setStatus('live');
      return stream;
    } catch {
      setStatus('unsupported');
      return null;
    }
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStatus('off');
  }, []);

  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  return { status, stream: streamRef, start, stop };
};
