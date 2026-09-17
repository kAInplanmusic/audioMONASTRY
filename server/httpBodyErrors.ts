/**
 * audioMONASTRY · HTTP-Body-Fehler ohne Stack-Trace (AI-P1-005)
 * =====================================================================
 * `express.json()` wirft bei ungueltigem JSON einen `SyntaxError` mit
 * `type = 'entity.parse.failed'`. Ohne eigenen Fehler-Middleware landet der
 * beim Express-Default-Handler, der den **kompletten Stack-Trace** auf stderr
 * schreibt (und im Nicht-Produktionsmodus sogar in die Antwort). Die Antwort
 * selbst war zwar korrekt (400), aber das Log-Rauschen erschwerte die
 * Fehlersuche - genau der Befund aus dem Abschlussbericht 2026-09-13 §13.6.
 *
 * Dieses Modul liefert stattdessen:
 *   * eine strukturierte JSON-Antwort (`error` + `requestId` + gekuerzte
 *     `cause`, ohne Stack-Frames, ohne Newlines),
 *   * genau EINE Log-Zeile mit Request-ID und Ursache,
 *   * und reicht alles, was kein Body-Fehler ist, unveraendert an `next(err)`
 *     weiter (kein Verhalten anderer Fehler wird umgedeutet).
 *
 * Die Erkennung ist rein (`describeJsonBodyError`) und damit ohne HTTP-Server
 * testbar.
 */
import type { NextFunction, Request, Response } from 'express';

/** Vom body-parser gesetzte `err.type`-Werte, die wir strukturiert beantworten. */
const PARSE_FAILED = 'entity.parse.failed';
const TOO_LARGE = 'entity.too.large';
/** Laenge, auf die die Ursache gekuerzt wird (verhindert Log-/Body-Flutung). */
export const MAX_CAUSE_LENGTH = 200;

export interface JsonBodyErrorInfo {
  /** HTTP-Status der Antwort (body-parser liefert `err.status`, wir setzen ihn hier fest). */
  status: 400 | 413;
  /** Maschinenlesbarer Fehlercode fuer die Antwort. */
  error: string;
  /** Gekuerzte, einzeilige Ursache (nur Log/Antwort-Detail, nie ein Stack). */
  cause: string;
}

/**
 * Normalisiert eine beliebige Ursache zu einer einzeiligen, gekuerzten Zeile.
 * Stack-Frames (`    at ...`) koennen so nie in Log oder Antwort landen.
 */
export function sanitizeCause(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw);
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'unbekannte Ursache';
  return singleLine.length > MAX_CAUSE_LENGTH ? `${singleLine.slice(0, MAX_CAUSE_LENGTH)}…` : singleLine;
}

/** Erkennt body-parser-Fehler und beschreibt sie; `null` fuer alles andere. */
export function describeJsonBodyError(err: unknown): JsonBodyErrorInfo | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { type?: unknown; message?: unknown; status?: unknown; statusCode?: unknown };
  const type = typeof e.type === 'string' ? e.type : '';
  const cause = sanitizeCause(e.message);
  if (type === PARSE_FAILED) return { status: 400, error: 'invalid JSON body', cause };
  if (type === TOO_LARGE) return { status: 413, error: 'payload too large', cause };
  return null;
}

/** Liest die von der Request-ID-Middleware gesetzte Korrelations-ID. */
export function requestIdOf(res: Response): string {
  const header = res.getHeader?.('X-Request-Id');
  const id = typeof header === 'string' ? header.trim() : '';
  return id || 'unbekannt';
}

export type BodyErrorLogger = (line: string) => void;

/**
 * Express-Fehler-Middleware. Muss **direkt nach** `express.json()` registriert
 * werden, damit Body-Parse-Fehler hier landen und nicht im Default-Handler.
 */
export function createJsonBodyErrorHandler(
  log: BodyErrorLogger = (line) => console.warn(line),
): (err: unknown, req: Request, res: Response, next: NextFunction) => void {
  return (err, _req, res, next) => {
    const info = describeJsonBodyError(err);
    if (!info) return next(err);

    const requestId = requestIdOf(res);
    // Genau eine Zeile: kein Stack, keine Mehrfach-Ausgabe.
    log(`[http-body] ${info.error} (requestId=${requestId}, cause=${info.cause})`);

    if (res.headersSent) return next(err);
    return res.status(info.status).json({ error: info.error, requestId, cause: info.cause });
  };
}
