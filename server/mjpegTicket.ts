/**
 * AUDIT-2026-10-30-P1-006 · Einmal-Ticket für den MJPEG-Strom
 * ===========================================================
 * Befund: Der Beamer liest den MJPEG-Fallback mit einem `<img>`; ein `<img>`
 * kann keine Header setzen. Deshalb stand der **Studio-Master-Token** als
 * `?token=` in der Stream-URL (`src/utils/visualMjpeg.ts`) — und damit in
 * Access-Logs, Referrern und der Browser-History. Ein Master-Token in einer URL
 * ist kein Zugangsnachweis, sondern eine dauerhafte Weitergabe des Schlüssels.
 *
 * Ersatz (dieses Modul): ein **kurzlebiges, einmal verwendbares, gebundenes**
 * Ticket.
 *
 *   - **Kurzlebig**: TTL standardmäßig 30 s (hart auf 60 s begrenzt, per
 *     `VISUAL_MJPEG_TICKET_TTL_MS` nur kleiner/länger innerhalb der Grenze).
 *     Es überbrückt den Verbindungsaufbau, keinen Betrieb.
 *   - **Einmalig**: Der erste erfolgreiche Zugriff verbraucht das Ticket. Ein
 *     zweiter Versuch meldet `used` — auch dann, wenn er Sekunden später kommt.
 *   - **Gebunden**: an die gemeldete Session (`x-session-id`, im Stream als
 *     `sid`-Query, weil ein `<img>` keine Header setzen kann) oder ersatzweise
 *     an die Client-IP. Ein fremder Client mit erbeuteter URL kommt damit nicht
 *     durch; ein Verbindungswechsel der IP innerhalb von 30 s ist der einzige
 *     bewusst offengelegte Restfall.
 *   - **Undurchsichtig**: 32 Zufallsbytes (base64url). Gespeichert wird nur der
 *     SHA-256-Kürzel — der Speicher enthält keine Tickets und keine Session-IDs
 *     im Klartext.
 *
 * Bewusst prozesslokal (wie der `VisualFrameHub`): mehrere App-Knoten liefern
 * den Strom ohnehin nur von dem Knoten, der die Frames bekommt.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Vorgabe-Lebensdauer eines Tickets. */
export const DEFAULT_MJPEG_TICKET_TTL_MS = 30_000;
/** Harte Obergrenze — ein Ticket ist kein Dauerzugang. */
export const MAX_MJPEG_TICKET_TTL_MS = 60_000;
export const MIN_MJPEG_TICKET_TTL_MS = 1_000;
/** Obergrenze offener Tickets (Speicherschutz gegen Issue-Flooding). */
export const MAX_MJPEG_TICKETS = 512;
/** 32 Zufallsbytes -> 43 Zeichen base64url. */
const TICKET_BYTES = 32;
/** Länge, ab der ein eingereichtes Ticket nicht mehr echt sein kann. */
const MAX_TICKET_INPUT = 128;
/** Session-Kennzeichen: identischer Zeichenvorrat wie src/core/session/sessionIdentity.ts. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/;

export type MjpegTicketSubjectKind = 'session' | 'ip';
export type MjpegTicketRejection = 'unknown' | 'expired' | 'used' | 'subject-mismatch';
export type MjpegTicketVerdict = 'ok' | MjpegTicketRejection;

export interface MjpegTicketSubject {
  /** Vom Client gemeldetes Session-/Kollaborations-Kennzeichen (`x-session-id`). */
  sessionId?: string;
  /** Client-IP (Express `req.ip`); nur Bindungsgrundlage, nie geloggt. */
  ip?: string;
}

export interface IssuedMjpegTicket {
  ticket: string;
  /** Epoch-Millisekunden. */
  expiresAt: number;
  ttlMs: number;
}

interface TicketRecord {
  kind: MjpegTicketSubjectKind;
  subject: string;
  expiresAt: number;
  usedAt: number | null;
}

/** Kürzel ohne Rückschluss auf Ticket/Session — dieselbe Idee wie rateLimitKeys.ts. */
function digest(value: string): string {
  return createHash('sha256')
    .update(`audioMONASTRY-mjpeg-ticket-2026\n${value}`)
    .digest('hex')
    .slice(0, 32);
}

function clampTtl(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MJPEG_TICKET_TTL_MS;
  return Math.min(MAX_MJPEG_TICKET_TTL_MS, Math.max(MIN_MJPEG_TICKET_TTL_MS, Math.floor(value)));
}

/**
 * Bindungs-Subject einer Anfrage. Eine gueltige Session ist staerker als die IP
 * (mehrere Nutzer hinter NAT) und wird deshalb bevorzugt.
 */
function resolveSubject(subject: MjpegTicketSubject): { kind: MjpegTicketSubjectKind; subject: string } {
  const sessionId = String(subject.sessionId ?? '').trim();
  if (SESSION_ID_RE.test(sessionId)) return { kind: 'session', subject: digest(`sid:${sessionId}`) };
  return { kind: 'ip', subject: digest(`ip:${String(subject.ip ?? '').trim()}`) };
}

export class MjpegTicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly now: () => number;
  readonly ttlMs: number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = clampTtl(options.ttlMs ?? process.env.VISUAL_MJPEG_TICKET_TTL_MS);
  }

  get size(): number {
    return this.tickets.size;
  }

  /**
   * Stellt ein Ticket aus. Aufzurufen NUR aus einem bereits authentifizierten
   * Handler: dieses Modul kennt keine Auth und prueft keine Tokens.
   */
  issue(subject: MjpegTicketSubject): IssuedMjpegTicket {
    const now = this.now();
    this.prune(now);
    if (this.tickets.size >= MAX_MJPEG_TICKETS) this.evictOldest();

    const ticket = randomBytes(TICKET_BYTES).toString('base64url');
    const expiresAt = now + this.ttlMs;
    const bound = resolveSubject(subject);
    this.tickets.set(digest(ticket), {
      kind: bound.kind,
      subject: bound.subject,
      expiresAt,
      usedAt: null,
    });
    return { ticket, expiresAt, ttlMs: this.ttlMs };
  }

  /**
   * Loest ein Ticket ein. Ein Fehlversuch (fremde Session/IP) verbraucht das
   * Ticket NICHT — sonst koennte jeder mit der erbeuteten URL den legitimen
   * Beamer aussperren. Erst der erfolgreiche Zugriff ist die Einmalverwendung.
   */
  redeem(ticket: unknown, subject: MjpegTicketSubject): MjpegTicketVerdict {
    const raw = typeof ticket === 'string' ? ticket.trim() : '';
    if (!raw || raw.length > MAX_TICKET_INPUT) return 'unknown';

    const key = digest(raw);
    const record = this.tickets.get(key);
    if (!record) return 'unknown';
    if (record.usedAt !== null) return 'used';

    const now = this.now();
    if (now >= record.expiresAt) {
      this.tickets.delete(key);
      return 'expired';
    }

    const bound = resolveSubject(subject);
    if (record.kind !== bound.kind || record.subject !== bound.subject) return 'subject-mismatch';

    record.usedAt = now;
    return 'ok';
  }

  /** Nur fuer Tests/Diagnose. */
  reset(): void {
    this.tickets.clear();
  }

  /**
   * Abgelaufene Tickets entfernen. Verbrauchte bleiben noch eine TTL lang
   * liegen, damit ein zweiter Zugriff ehrlich `used` meldet statt `unknown`.
   */
  private prune(now = this.now()): void {
    for (const [key, record] of this.tickets) {
      if (now >= record.expiresAt + this.ttlMs) this.tickets.delete(key);
    }
  }

  private evictOldest(): void {
    const oldest = this.tickets.keys().next();
    if (!oldest.done) this.tickets.delete(oldest.value);
  }
}
