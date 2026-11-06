/**
 * Routen des MJPEG-Fallbacks (VISUAL-P1-001)
 * ==========================================
 * `POST /api/visual/frame`        – Studio schiebt einen JPEG-/WebP-Frame ein
 * `POST /api/visual/mjpeg-ticket` – stellt ein kurzlebiges Einmal-Ticket aus
 * `GET  /api/visual/mjpeg`        – Strom fuer Clients MIT Credentials
 * `GET  /visual-stream/mjpeg`     – Strom fuer den `<img>`-Beamer (nur Ticket)
 * `GET  /api/visual/status`       – Studio fragt, ob jemand schaut (und wie viele)
 *
 * AUDIT-2026-10-30-P1-006: Der Strom trug frueher den Studio-MASTER-Token als
 * Query-Parameter `token` (ein `<img>` kann keine Header setzen). Damit stand
 * der Schluessel in Access-Logs, Referrern und der Browser-History. Jetzt gilt:
 *
 *   - Das Master-Token wird NUR noch als Header/Cookie angenommen (wie ueberall).
 *   - Fuer den `<img>`-Strom gibt die authentifizierte Route `mjpeg-ticket` ein
 *     undurchsichtiges Ticket aus (TTL <= 60 s, einmal verwendbar, an Session
 *     bzw. Client-IP gebunden, siehe server/mjpegTicket.ts).
 *   - Der Strom akzeptiert NUR dieses Ticket (oder fuer Skripte den Header).
 *     Ein Master-Token im Query ist hier wertlos - der Test dazu steht in
 *     tests/visualMjpegRoutes.test.ts.
 *
 * WARUM `/visual-stream/mjpeg` (nicht unter `/api`)?
 * Die globale `/api`-Auth-Middleware in `server.ts` laesst eine Anfrage ohne
 * Header/Cookie nur mit dem Master-Token im Query durch (die alte Ausnahme, die
 * dieser Befund gerade entfernt). Ein `<img>` kann weder Header noch Cookies
 * *waehlen* - es sendet nur, was der Browser hat. Damit ein Beamer ohne
 * Studio-Cookie ueberhaupt einen Zugang hat, liegt die ticket-gepruefte
 * Stream-Route ausserhalb des `/api`-Prefix. Der Nachweis ist dort das Ticket
 * (256 Bit Zufall, TTL <= 60 s, einmal verwendbar, gebunden) - nicht der
 * Master-Token. Diese Route ist bewusst die einzige ausserhalb von `/api`.
 * Sobald `server.ts` seine Query-Ausnahme entfernt, kann `/api/visual/mjpeg`
 * allein die Ticket-Route sein; der Handler ist derselbe.
 */
import express from 'express';
import { MjpegTicketStore } from '../mjpegTicket.ts';
import {
  MAX_FRAME_BYTES,
  mjpegHeaders,
  mjpegPart,
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
  /** Ticket-Speicher (Tests injizieren Uhr/TTL; Vorgabe: prozesslokal). */
  tickets?: MjpegTicketStore;
}

/** Session-Kennzeichen, das der Client bei der Ticket-Ausstellung mitschickt. */
const SESSION_IDENTITY_HEADER = 'x-session-id';

function headerValue(req: express.Request, name: string): string {
  return String((req.headers as Record<string, unknown> | undefined)?.[name] ?? '');
}

function queryValue(req: express.Request, name: string): string {
  const raw = (req.query as Record<string, unknown> | undefined)?.[name];
  return typeof raw === 'string' ? raw : '';
}

export function registerVisualRoutes(app: express.Express, deps: VisualRoutesDeps): void {
  const { hub, tokenFromRequest, safeTokenEqual, studioAccessToken, studioAuthOpen } = deps;
  const firstFrameTimeoutMs = Math.max(1_000, Number(deps.firstFrameTimeoutMs ?? 15_000));
  const tickets = deps.tickets ?? new MjpegTicketStore();

  /** Bindungs-Subject: gemeldete Session, sonst Client-IP. */
  const subjectOf = (req: express.Request, sessionId?: string) => ({
    sessionId: sessionId ?? headerValue(req, SESSION_IDENTITY_HEADER),
    ip: req.ip,
  });

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

  // --- Ticket-Ausstellung fuer den `<img>`-Strom (AUDIT-2026-10-30-P1-006).
  //
  // Diese Route liegt HINTER der globalen /api-Auth (Header, Cookie oder
  // signiertes Portal-Session-Token). Wer hier ankommt, ist authentifiziert;
  // ohne Studio-Auth (Dev/Test) ist ohnehin alles offen. Ein Query-Token gibt es
  // auf dieser Route nicht - der Nachweis ist Header/Cookie.
  app.post('/api/visual/mjpeg-ticket', (req, res) => {
    if (!studioAuthOpen && !tokenFromRequest(req)) {
      return res.status(401).json({ error: 'STUDIO_TOKEN_REQUIRED' });
    }
    res.setHeader('Cache-Control', 'no-store');
    const issued = tickets.issue(subjectOf(req));
    res.json({ ok: true, ...issued });
  });

  const serveMjpeg = (req: express.Request, res: express.Response) => {
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
  };

  /**
   * Prueft das Einmal-Ticket. `sid` steht im Query, weil ein `<img>` keine
   * Header setzen kann; das Kennzeichen ist kein Geheimnis, sondern bindet das
   * Ticket an die Session. Rueckgabe `null` = Zugang erlaubt.
   */
  const checkTicket = (req: express.Request, res: express.Response): boolean => {
    const ticket = queryValue(req, 'ticket');
    if (!ticket) {
      res.status(401).json({ error: 'MJPEG_TICKET_REQUIRED' });
      return false;
    }
    const verdict = tickets.redeem(ticket, subjectOf(req, queryValue(req, 'sid')));
    if (verdict !== 'ok') {
      // 403 (nicht 401): es wurde etwas vorgelegt, es ist nur nicht (mehr) gueltig.
      res.status(403).json({ error: 'MJPEG_TICKET_INVALID', reason: verdict });
      return false;
    }
    return true;
  };

  // --- Der Strom fuer den `<img>`-Beamer: ausserhalb von `/api`, weil die
  // dortige Auth-Middleware eine Anfrage ohne Header/Cookie abweist (siehe
  // Modulkopf). Der einzige Nachweis hier ist das Einmal-Ticket.
  app.get('/visual-stream/mjpeg', (req, res) => {
    if (!studioAuthOpen && !checkTicket(req, res)) return;
    serveMjpeg(req, res);
  });

  // --- Derselbe Strom unter `/api` (Skripte/API-Clients mit Header/Cookie).
  // Ein Ticket wird auch hier akzeptiert (fuer cookie-authentifizierte Clients),
  // ein Master-Token im Query NICHT.
  app.get('/api/visual/mjpeg', (req, res) => {
    if (!studioAuthOpen) {
      if (queryValue(req, 'ticket')) {
        if (!checkTicket(req, res)) return;
      } else {
        const headerToken = tokenFromRequest(req);
        if (!headerToken || !safeTokenEqual(headerToken, studioAccessToken)) {
          return res.status(401).json({ error: 'STUDIO_TOKEN_REQUIRED' });
        }
      }
    }
    serveMjpeg(req, res);
  });
}
