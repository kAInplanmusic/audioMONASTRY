/**
 * audioMONASTRY · MJPEG-Fallback für den Visual-Stream (VISUAL-P1-001)
 * =====================================================================
 * Der Visual-Stream zum Beamer läuft normal über WebRTC/SFU (Ghostuser 6,
 * `/visual-out`). Die Spezifikation nennt seit Beginn einen **Fallback ohne SFU**
 * (`docs/VISUALMONK_SPEC.md`: „Fallback ohne SFU: MJPEG/WebP über WebSocket oder
 * HLS-Frames") — gebaut war er nie. Genau der Fall, in dem er zählt, ist der
 * Beamer: dort hängt ein fremdes Gerät, oft ohne Studio-Login, ohne SFU-Freigabe
 * und ohne Möglichkeit, Signalisierungs-Header zu setzen. Ein `<img
 * src="…/api/visual/mjpeg?token=…">` funktioniert dort, wo WebRTC scheitert.
 *
 * Aufbau:
 *
 *   Studio-Canvas --(POST /api/visual/frame, JPEG/WebP)--> VisualFrameHub
 *                                                              |
 *                        GET /api/visual/mjpeg  <-- multipart/x-mixed-replace
 *                                                              |
 *                                              Beamer (nur ein <img>)
 *
 * Drei Entscheidungen, die den Betrieb tragen:
 *
 * 1. **Der Studio-Knoten sendet nur, wenn jemand schaut.** `GET /api/visual/status`
 *    meldet die Zuschauerzahl; ohne Zuschauer wird kein Frame enkodiert. Ein
 *    dauerhaftes JPEG-Encoding auf dem Audio-Thread wäre genau die Last, die der
 *    VisualMONK nicht verursachen darf.
 * 2. **Frames werden begrenzt und verworfen, nicht gestaut.** Zu grosse
 *    (MAX_FRAME_BYTES), zu schnelle (> maxFps) und fremde Typen werden mit Grund
 *    abgelehnt (`publish` liefert nie stillschweigend Erfolg). Ein Beamer, der
 *    nicht hinterherkommt, bekommt den NAECHSTEN Frame, keine Warteschlange —
 *    bei Live-Bild ist der alte Frame wertlos.
 * 3. **Auth über `?token=` NUR auf dieser einen Route.** Ein `<img>` kann keine
 *    Header setzen. Statt die globale Middleware zu öffnen, akzeptiert genau
 *    `/api/visual/mjpeg` den Token als Query-Parameter und vergleicht ihn mit
 *    `safeTokenEqual` (dieselbe bewusste, eng begrenzte Ausnahme wie beim
 *    Alert-Webhook). Alles andere bleibt Header/Cookie.
 */
import type { IncomingMessage } from 'node:http';

export const MJPEG_BOUNDARY = 'audiomonastryframe';
export const MAX_FRAME_BYTES = 512 * 1024;
export const DEFAULT_MAX_FPS = 12;
export const ALLOWED_FRAME_TYPES = ['image/jpeg', 'image/webp'] as const;

export interface VisualFrame {
  data: Buffer;
  contentType: string;
  at: number;
}

export type PublishRejection = 'empty' | 'too-large' | 'too-fast' | 'unsupported-type';
export type PublishResult = { ok: true; frame: VisualFrame } | { ok: false; reason: PublishRejection };

export interface VisualFrameHubOptions {
  maxFps?: number;
  maxFrameBytes?: number;
  now?: () => number;
}

/** Ein Multipart-Teil nach RFC 2046 (`multipart/x-mixed-replace`). */
export function mjpegPart(frame: VisualFrame, boundary = MJPEG_BOUNDARY): Buffer {
  const header = `--${boundary}\r\nContent-Type: ${frame.contentType}\r\nContent-Length: ${frame.data.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'latin1'), frame.data, Buffer.from('\r\n', 'latin1')]);
}

export function mjpegHeaders(): Record<string, string> {
  return {
    'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    // Kein Zwischenspeicher: ein gepufferter MJPEG-Strom zeigt Standbilder.
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    // KEIN `Connection: close`: ein MJPEG-Strom ist ein Dauerstrom. Chromium hat
    // den Strom mit diesem Header als beendet behandelt (der Beamer-Beweis zeigte
    // danach kein Bild mehr) - der Client beendet die Verbindung selbst, wenn er
    // das <img> entfernt.
    Pragma: 'no-cache',
  };
}

/**
 * Token aus `?token=` lesen — nur für den `<img>`-Fall (siehe Modulkopf).
 * `originalUrl` zuerst: Express kann `req.url` beim Mounten kürzen, `originalUrl`
 * bleibt die vollstaendige Anfrage (genau daran scheiterte der erste Testlauf:
 * der Query-Token war da, wurde aber nicht gefunden).
 */
export function tokenFromUrl(req: Pick<IncomingMessage, 'url'> & { originalUrl?: string }): string {
  const url = String(req.originalUrl || req.url || '');
  const index = url.indexOf('?');
  if (index === -1) return '';
  const params = new URLSearchParams(url.slice(index + 1));
  return params.get('token') ?? '';
}

export class VisualFrameHub {
  private latestFrame: VisualFrame | null = null;
  private readonly subscribers = new Set<(frame: VisualFrame) => void>();
  private lastAcceptedAt = 0;
  private readonly maxFps: number;
  private readonly maxFrameBytes: number;
  private readonly now: () => number;
  private dropped = 0;
  private rejected: Record<PublishRejection, number> = { empty: 0, 'too-large': 0, 'too-fast': 0, 'unsupported-type': 0 };

  constructor(options: VisualFrameHubOptions = {}) {
    this.maxFps = Math.max(1, Number(options.maxFps ?? process.env.VISUAL_MAX_FPS ?? DEFAULT_MAX_FPS));
    this.maxFrameBytes = Math.max(1024, Number(options.maxFrameBytes ?? MAX_FRAME_BYTES));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Nimmt einen Frame an oder lehnt ihn mit Grund ab. Gibt nie stillschweigend
   * Erfolg zurueck - der Aufrufer (Studio) soll wissen, ob sein Bild ankommt.
   */
  publish(data: Buffer | Uint8Array, contentType: string): PublishResult {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
    if (buffer.length === 0) return this.reject('empty');
    if (buffer.length > this.maxFrameBytes) return this.reject('too-large');
    if (!(ALLOWED_FRAME_TYPES as readonly string[]).includes(type)) return this.reject('unsupported-type');

    const at = this.now();
    const minInterval = 1000 / this.maxFps;
    if (this.lastAcceptedAt > 0 && at - this.lastAcceptedAt < minInterval) {
      this.dropped += 1;
      return this.reject('too-fast');
    }

    const frame: VisualFrame = { data: buffer, contentType: type, at };
    this.latestFrame = frame;
    this.lastAcceptedAt = at;
    for (const listener of this.subscribers) {
      try {
        listener(frame);
      } catch { /* ein kaputter Zuschauer darf den Hub nicht stoppen */ }
    }
    return { ok: true, frame };
  }

  private reject(reason: PublishRejection): PublishResult {
    this.rejected[reason] += 1;
    return { ok: false, reason };
  }

  get latest(): VisualFrame | null {
    return this.latestFrame;
  }

  get viewerCount(): number {
    return this.subscribers.size;
  }

  /** Zuschauer anmelden (Rueckgabe: abmelden). */
  subscribe(listener: (frame: VisualFrame) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  status(): {
    viewers: number;
    hasFrame: boolean;
    maxFps: number;
    maxFrameBytes: number;
    droppedTooFast: number;
    rejected: Record<PublishRejection, number>;
  } {
    return {
      viewers: this.viewerCount,
      hasFrame: this.latestFrame !== null,
      maxFps: this.maxFps,
      maxFrameBytes: this.maxFrameBytes,
      droppedTooFast: this.dropped,
      rejected: { ...this.rejected },
    };
  }

  /** Nur fuer Tests/Diagnose: Zaehler zuruecksetzen. */
  reset(): void {
    this.latestFrame = null;
    this.lastAcceptedAt = 0;
    this.dropped = 0;
    this.rejected = { empty: 0, 'too-large': 0, 'too-fast': 0, 'unsupported-type': 0 };
  }
}

/** Zerlegt einen MJPEG-Strom wieder in Frames (fuer Tests und Konsumenten). */
export function parseMjpegStream(buffer: Buffer, boundary = MJPEG_BOUNDARY): VisualFrame[] {
  const frames: VisualFrame[] = [];
  const delimiter = `--${boundary}\r\n`;
  const parts = buffer.toString('latin1').split(delimiter).slice(1);
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd);
    const typeMatch = header.match(/Content-Type:\s*([^\r\n]+)/i);
    const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!typeMatch || !lengthMatch) continue;
    const body = part.slice(headerEnd + 4, headerEnd + 4 + Number(lengthMatch[1]));
    frames.push({ data: Buffer.from(body, 'latin1'), contentType: typeMatch[1].trim(), at: 0 });
  }
  return frames;
}
