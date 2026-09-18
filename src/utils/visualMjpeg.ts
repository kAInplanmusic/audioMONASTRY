/**
 * MJPEG-Fallback, Client-Seite (VISUAL-P1-001)
 * ===========================================
 * Zwei Rollen, beide hier:
 *
 *   - **Studio**: schickt Canvas-Frames an den Server — aber nur, solange ein
 *     Zuschauer verbunden ist (`/api/visual/status`). Ohne Zuschauer wird nichts
 *     enkodiert, sonst kostet der Fallback dauerhaft CPU auf dem Studio-Rechner.
 *   - **Beamer**: liest den Strom mit einem `<img>`. Ein `<img>` kann keine
 *     Header setzen, deshalb reicht der Server den Token auf dieser einen Route
 *     als `?token=` durch.
 *
 * Die Zeitlogik ist absichtlich injizierbar (`now`, `fetchImpl`, `encodeFrame`),
 * damit Frequenzbegrenzung und Fehlerverhalten ohne Browser/Echtzeit testbar sind.
 */

export const DEFAULT_PUBLISH_MAX_FPS = 12;
export const DEFAULT_STATUS_INTERVAL_MS = 2_000;

export function mjpegStreamUrl(token: string): string {
  const base = '/api/visual/mjpeg';
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export const visualFrameUrl = (): string => '/api/visual/frame';
export const visualStatusUrl = (): string => '/api/visual/status';

/** Studio-Token aus dem eigenen Cookie (das Portal setzt es beim Betreten). */
export function studioTokenFromCookie(cookie = typeof document === 'undefined' ? '' : document.cookie): string {
  const match = String(cookie ?? '').match(/(?:^|;\s*)studio=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/** Frequenzgrenze: darf jetzt gesendet werden? */
export function shouldPublishFrame(lastSentAt: number, now: number, maxFps = DEFAULT_PUBLISH_MAX_FPS): boolean {
  if (lastSentAt <= 0) return true;
  const minInterval = 1000 / Math.max(1, maxFps);
  return now - lastSentAt >= minInterval;
}

export interface FallbackPublisherOptions {
  /** Canvas, dessen Bild gesendet wird. */
  getCanvas: () => HTMLCanvasElement | null;
  token: string;
  maxFps?: number;
  quality?: number;
  statusIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Frame-Encoding (injizierbar fuer Tests). */
  encodeFrame?: (canvas: HTMLCanvasElement, quality: number) => Promise<Blob | null>;
  onError?: (message: string) => void;
}

export interface FallbackPublisher {
  /** Einmaliger Durchlauf: Status holen, ggf. einen Frame senden. */
  tick(): Promise<{ viewers: number; sent: boolean }>;
  start(): void;
  stop(): void;
  readonly running: boolean;
}

const defaultEncode = (canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') return resolve(null);
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });

export function createFallbackPublisher(options: FallbackPublisherOptions): FallbackPublisher {
  const fetchImpl = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const maxFps = options.maxFps ?? DEFAULT_PUBLISH_MAX_FPS;
  const quality = options.quality ?? 0.7;
  const now = options.now ?? (() => Date.now());
  const encodeFrame = options.encodeFrame ?? defaultEncode;
  const statusIntervalMs = Math.max(250, Number(options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS));
  let lastSentAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  const tick = async (): Promise<{ viewers: number; sent: boolean }> => {
    if (!fetchImpl) return { viewers: 0, sent: false };
    if (busy) return { viewers: 0, sent: false };
    busy = true;
    try {
      const statusRes = await fetchImpl(visualStatusUrl(), {
        headers: options.token ? { 'x-studio-token': options.token } : {},
      });
      if (!statusRes.ok) return { viewers: 0, sent: false };
      const status = (await statusRes.json()) as { viewers?: number };
      const viewers = Number(status?.viewers ?? 0);
      const canvas = options.getCanvas();
      // Ohne Zuschauer oder ohne Canvas wird NICHTS enkodiert.
      if (viewers <= 0 || !canvas) return { viewers, sent: false };
      if (!shouldPublishFrame(lastSentAt, now(), maxFps)) return { viewers, sent: false };

      const blob = await encodeFrame(canvas, quality);
      if (!blob) return { viewers, sent: false };
      const res = await fetchImpl(visualFrameUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'image/jpeg',
          ...(options.token ? { 'x-studio-token': options.token } : {}),
        },
        body: blob,
      });
      const accepted = res.ok || res.status === 202;
      if (accepted) lastSentAt = now();
      return { viewers, sent: accepted };
    } catch (e) {
      options.onError?.((e as Error).message);
      return { viewers: 0, sent: false };
    } finally {
      busy = false;
    }
  };

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, statusIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get running() {
      return timer !== null;
    },
  };
}
