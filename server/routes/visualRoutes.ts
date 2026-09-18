/**
 * Routen des MJPEG-Fallbacks (VISUAL-P1-001)
 * ==========================================
 * `POST /api/visual/frame`   – Studio schiebt einen JPEG-/WebP-Frame ein
 * `GET  /api/visual/mjpeg`   – Beamer/`<img>` liest den Strom (Token auch als `?token=`)
 * `GET  /api/visual/status`  – Studio fragt, ob jemand schaut (und wie viele)
 *
 * Die Routen selbst sind duenn: die Politik (Groessen-/Frequenzgrenze, Verwerfen
 * statt Stauen) liegt im Hub, damit sie ohne HTTP testbar bleibt.
 */
import express from 'express';
import {
  MAX_FRAME_BYTES,
  mjpegHeaders,
  mjpegPart,
  tokenFromUrl,
  type VisualFrameHub,
} from '../visualStream.ts';

export interface VisualRoutesDeps {
  hub: VisualFrameHub;
  /** Regulaere Token-Sicht (Header/Cookie) wie bei allen anderen /api-Routen. */
  tokenFromRequest: (req: express.Request) => string;
  safeTokenEqual: (a: string, b: string) => boolean;
  /** Erwarteter Studio-Token; leer = keine Pruefung (Dev/Test). */
  studioAccessToken: string;
  studioAuthOpen: boolean;
  /** Wie lange auf den ersten Frame gewartet wird, bevor der Strom endet. */
  firstFrameTimeoutMs?: number;
}

export function registerVisualRoutes(app: express.Express, deps: VisualRoutesDeps): void {
  const { hub, tokenFromRequest, safeTokenEqual, studioAccessToken, studioAuthOpen } = deps;
  const firstFrameTimeoutMs = Math.max(1_000, Number(deps.firstFrameTimeoutMs ?? 15_000));

  // --- Frame-Annahme (Studio). Auth wie ueberall: Header/Cookie.
  app.post(
    '/api/visual/frame',
    express.raw({ type: ['image/jpeg', 'image/webp', 'application/octet-stream'], limit: MAX_FRAME_BYTES + 4096 }),
    (req, res) => {
      if (!studioAuthOpen) {
        const token = tokenFromRequest(req);
        if (!token || !safeTokenEqual(token, studioAccessToken)) {
          return res.status(401).json({ error: 'STUDIO_TOKEN_REQUIRED' });
        }
      }
      const body = req.body as Buffer | undefined;
      // express.raw parst nur die erlaubten Typen; bei fremdem Content-Type bleibt
      // `{}` uebrig. Das ist ein TYPfehler (415) und kein Serverfehler.
      if (!Buffer.isBuffer(body)) return res.status(415).json({ ok: false, reason: 'unsupported-type' });
      if (body.length === 0) return res.status(400).json({ ok: false, reason: 'empty' });
      if (body.length > MAX_FRAME_BYTES) return res.status(413).json({ ok: false, reason: 'too-large' });
      const contentType = String(req.headers['content-type'] ?? '');
      const result = hub.publish(body, contentType);
      // tsconfig ohne `strict`: boolesche Diskriminanten greifen nicht -> `in`.
      if (!('reason' in result)) {
        return res.json({ ok: true, bytes: result.frame.data.length, contentType: result.frame.contentType });
      }
      const status = result.reason === 'too-large' ? 413 : result.reason === 'unsupported-type' ? 415 : 202;
      return res.status(status).json({ ok: false, reason: result.reason });
    },
  );

  // --- Status (Studio entscheidet damit, ob es ueberhaupt Frames enkodiert).
  app.get('/api/visual/status', (req, res) => {
    if (!studioAuthOpen) {
      const token = tokenFromRequest(req);
      if (!token || !safeTokenEqual(token, studioAccessToken)) {
        return res.status(401).json({ error: 'STUDIO_TOKEN_REQUIRED' });
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...hub.status() });
  });

  // --- Der Strom selbst. Token-Query NUR hier (ein <img> kann keine Header setzen).
  app.get('/api/visual/mjpeg', (req, res) => {
    if (!studioAuthOpen) {
      const headerToken = tokenFromRequest(req);
      const queryToken = tokenFromUrl(req);
      const presented = headerToken || queryToken;
      if (!presented || !safeTokenEqual(presented, studioAccessToken)) {
        return res.status(401).json({ error: 'STUDIO_TOKEN_REQUIRED' });
      }
    }

    res.writeHead(200, mjpegHeaders());
    let closed = false;
    let waiting: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = hub.subscribe((frame) => {
      if (closed) return;
      // WICHTIG (vom Live-Browser-Beweis aufgedeckt): sobald der erste Frame
      // laeuft, muss die Wartezeit enden - sonst schliesst der Timer den Strom
      // MITTEN im Betrieb (Bild am Beamer friert ein, Zuschauer faellt aus der
      // Zaehlung). Genau das passierte: nach 15 s war der Beamer wieder "weg".
      if (waiting) {
        clearTimeout(waiting);
        waiting = null;
      }
      try {
        res.write(mjpegPart(frame));
      } catch {
        cleanup();
      }
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (waiting) clearTimeout(waiting);
      unsubscribe();
      try {
        res.end();
      } catch { /* Verbindung schon weg */ }
    };

    req.on('close', cleanup);
    req.on('aborted', cleanup);

    const latest = hub.latest;
    if (latest) {
      res.write(mjpegPart(latest));
    } else {
      // Ehrlich warten: ohne Frame im Hub endet der Strom nach dem Zeitlimit,
      // statt einen leer laufenden Multipart-Rahmen zu behaupten.
      waiting = setTimeout(cleanup, firstFrameTimeoutMs);
      waiting.unref?.();
    }
  });
}
