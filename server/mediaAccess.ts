/**
 * audioMONASTRY · Zugriffsschutz fuer Medienpfade (PROD-P1-006)
 * ================================================================================
 * Warum es diese Datei gibt:
 *
 * Der Audit vom 2026-09-23 hat gemessen, dass `dist/music` ein SYMLINK auf
 * `public/music` ist und `express.static(distPath)` ihn mit ausliefert
 * (`ls -la dist/music` -> `dist/music -> ../public/music`). Damit waren die
 * 45 Demo-Tracks auf JEDEM Host, auf dem der Ordner liegt, oeffentlich
 * abrufbar - ohne Token, ohne Anmeldung. Das Register
 * (docs/LICENSE_EXTERNAL_RESOURCES.md) erlaubt die Ablage auf den
 * Flotten-Knoten, aber diese Tracks stehen unter fremden Rechten; eine
 * oeffentliche Auslieferung ist damit nicht gedeckt.
 *
 * Die Sperre ist deshalb KEINE Pfad-Blacklist, sondern dieselbe Zugangsregel
 * wie fuer `/api/*`: gueltiger Studio-Token. Drei Quellen werden akzeptiert,
 * weil ein `<audio>`-Element keine eigenen Header setzen kann:
 *   * Header `x-studio-token`  (Skripte, Tests, fetch)
 *   * `?token=`                (Clients ohne Header UND ohne Cookie)
 *   * Cookie `studio`          (der Normalfall im Browser - <audio> sendet ihn mit)
 * Dazu das signierte Session-Token des Portals (SEC-P2-002), geprueft vom
 * Aufrufer (die Signaturpruefung ist asynchron und bleibt dort, wo sie schon
 * liegt - hier wird nur das Ergebnis entgegengenommen).
 *
 * Bewusst NICHT enthalten:
 *   * Kein Eingriff in die bestehende `/api`-Auth-Middleware. Ein Umbau des
 *     laufenden Auth-Pfads waere das groessere Risiko als diese kleine,
 *     getrennte Pruefung; beide benutzen aber dieselben Primitive
 *     (studioTokenFromRequest, STUDIO_ACCESS_TOKEN, Session-Pruefung).
 *   * Kein fail-open. Fehlt der Studio-Token in der Konfiguration, ist der
 *     Medienpfad ZU (503) - genau wie die API.
 *
 * Die Logik ist rein (kein Express-Import) und damit ohne Server testbar.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Pfade, die einen gueltigen Studio-Zugang verlangen. Segmentgenau geprueft:
 * `/music` und `/music/...` ja, `/musical` und `/musik` nein.
 */
export const PROTECTED_MEDIA_PREFIXES = ['/music'] as const;

/** Woher kam der akzeptierte Token? (fuer Log/Audit, nie der Wert selbst) */
export type MediaAccessVia = 'open' | 'header' | 'query' | 'cookie' | 'session';

export interface MediaAccessInput {
  /** Token aus dem Header `x-studio-token`. */
  headerToken?: string;
  /** Token aus `?token=` in der URL. */
  queryToken?: string;
  /** Token aus dem `studio`-Cookie. */
  cookieToken?: string;
}

export interface MediaAccessConfig {
  /** Kein STUDIO_ACCESS_TOKEN konfiguriert -> nicht konfigurierter Server. */
  studioTokenMissing: boolean;
  /** Expliziter Dev-/Testmodus ohne Auth (`studioAuthOpen`). */
  studioAuthOpen: boolean;
  /** Der gueltige Studio-Zugangstoken. */
  accessToken: string;
}

export type MediaAccessDecision =
  | { allow: true; via: MediaAccessVia }
  | { allow: false; status: 401 | 503; code: 'STUDIO_TOKEN_REQUIRED' | 'STUDIO_TOKEN_MISSING' };

/** Pfad ohne Query, ohne abschliessenden Slash - stabile Vergleiche. */
function normalizePath(value: unknown): string {
  const withoutQuery = String(value ?? '').split('?')[0];
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
}

/**
 * Liegt dieser Pfad unter einem geschuetzten Medienpraefix?
 * Segmentgrenze wird respektiert, damit `/music` nicht `/musical` mitnimmt.
 */
export function isProtectedMediaPath(pathname: unknown): boolean {
  const path = normalizePath(pathname);
  return PROTECTED_MEDIA_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Konstantzeit-Vergleich fuer Token.
 *
 * Ueber SHA-256-Digests, damit auch unterschiedlich lange Eingaben konstant
 * verglichen werden - ein frueher Laengenvergleich verraet sonst die Laenge des
 * erwarteten Tokens. `timingSafeEqual` verlangt gleich lange Buffer, und genau
 * das ist nach dem Hashing immer der Fall (32 Byte).
 */
export function constantTimeTokenEquals(a: unknown, b: unknown): boolean {
  const left = createHash('sha256').update(String(a ?? '')).digest();
  const right = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(left, right);
}

/**
 * Entscheidet den Zugriff auf einen Medienpfad.
 *
 * Reihenfolge: offener Dev-Modus -> nicht konfiguriert (fail-closed) ->
 * Header -> Query -> Cookie -> Session-Token -> 401.
 *
 * `sessionTokenValid` reicht der Aufrufer herein, weil die Signaturpruefung
 * asynchron ist (Web Crypto) und der Aufrufer sie nur dann bemuehen soll, wenn
 * ueberhaupt ein Token vorliegt, das wie ein Session-Token aussieht.
 */
export function decideMediaAccess(
  input: MediaAccessInput,
  config: MediaAccessConfig,
  sessionTokenValid = false,
): MediaAccessDecision {
  if (config.studioAuthOpen) return { allow: true, via: 'open' };
  if (config.studioTokenMissing) {
    return { allow: false, status: 503, code: 'STUDIO_TOKEN_MISSING' };
  }
  const sources: { token: string; via: Exclude<MediaAccessVia, 'open' | 'session'> }[] = [
    { token: String(input.headerToken ?? ''), via: 'header' },
    { token: String(input.queryToken ?? ''), via: 'query' },
    { token: String(input.cookieToken ?? ''), via: 'cookie' },
  ];
  for (const source of sources) {
    if (source.token !== '' && constantTimeTokenEquals(source.token, config.accessToken)) {
      return { allow: true, via: source.via };
    }
  }
  if (sessionTokenValid) return { allow: true, via: 'session' };
  return { allow: false, status: 401, code: 'STUDIO_TOKEN_REQUIRED' };
}

/** Verbots-Variante der Entscheidung (enger typisiert). */
export type MediaAccessDenied = Extract<MediaAccessDecision, { allow: false }>;

/**
 * Type-Guard fuer die Verbots-Variante.
 *
 * Warum als Guard und nicht als `if (!decision.allow)`: TypeScript verengt
 * hier nicht zuverlaessig ueber das Boolean-Literal (gemessen 2026-09-23 -
 * `decision.status` blieb in beiden Schreibweisen ein Fehler TS2339). Ein
 * Guard ist ehrlicher als ein Cast: er prueft zur Laufzeit und dokumentiert
 * die Absicht im Namen.
 */
export function isMediaAccessDenied(decision: MediaAccessDecision): decision is MediaAccessDenied {
  return decision.allow === false;
}

/** Token aus `?token=` lesen (Express-Query oder rohe Query-Zeichenkette). */
export function tokenFromQueryString(query: unknown): string {
  if (typeof query === 'string') {
    const m = /(?:^|[?&])token=([^&]+)/.exec(query);
    return m ? decodeURIComponent(m[1]) : '';
  }
  if (query && typeof query === 'object') {
    const raw = (query as Record<string, unknown>).token;
    return typeof raw === 'string' ? raw : '';
  }
  return '';
}

/** Token aus einem rohen Cookie-Header lesen (Cookie-Name: `studio`). */
export function tokenFromCookieHeader(cookieHeader: unknown): string {
  const m = /(?:^|;\s*)studio=([^;]+)/.exec(String(cookieHeader ?? ''));
  return m ? decodeURIComponent(m[1]) : '';
}
