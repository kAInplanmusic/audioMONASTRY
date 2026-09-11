/**
 * audioMONASTRY · Studio-Session-Token (SEC-P2-002)
 * =================================================
 * Warum: Das Portal gab dem Browser bisher den **Master-Token**
 * (`STUDIO_ACCESS_TOKEN`) als Cookie mit — 24 h gültig, ohne serverseitige
 * Ablauffrist. Wer das Cookie erbeutet, hatte damit den *dauerhaften* Zugang
 * (siehe docs/SECURITY_COOKIES.md, Befund F-1).
 *
 * Diese Datei stellt stattdessen ein **kurzlebiges, signiertes Session-Token**
 * bereit:
 *
 *   Format:  `v1.<exp>.<hmac-sha256-hex>`
 *   Signatur über: `v1.<exp>`   (HMAC mit `SESSION_SECRET`)
 *
 * Eigenschaften:
 *   * **Additiv**: der Master-Token wird weiter akzeptiert (Skripte, CI,
 *     API-Clients, alte Cookies) — es bricht nichts, wenn der Server das
 *     `SESSION_SECRET` noch nicht kennt (dann gilt nur der Master-Token).
 *   * **Fail-closed**: ohne `SESSION_SECRET` wird ein Session-Token abgelehnt
 *     (nicht „durchgewinkt“). Das Präfix `v1.` verhindert außerdem, dass ein
 *     Master-Token versehentlich als Session-Token interpretiert wird.
 *   * **Rein & testbar**: nur Web Crypto (Node ≥18 und Cloudflare Workers),
 *     keine Uhr-Abhängigkeit im Kern (`nowSec` injizierbar).
 */

/** Präfix, damit Session-Token nie mit einem Master-Token verwechselt werden. */
export const STUDIO_SESSION_PREFIX = 'v1.';

/** Vorgabe-Lebensdauer: 15 Minuten (vorher: 24 h Cookie mit Master-Token). */
export const STUDIO_SESSION_TTL_S = 900;

export interface StudioSessionClaims {
  /** Ablaufzeit in Sekunden seit Epoch. */
  exp: number;
  /** Optionaler Träger (z. B. Portal-Session-ID) — nur für Diagnose. */
  sub?: string;
}

/** Baut das Token aus Claims und Signatur (pur, für Tests/Portal). */
export function buildStudioSessionToken(exp: number, signatureHex: string, sub?: string): string {
  const body = sub ? `${STUDIO_SESSION_PREFIX}${exp}.${sub}` : `${STUDIO_SESSION_PREFIX}${exp}`;
  return `${body}.${signatureHex}`;
}

/** Zeichenkette, die signiert wird (`v1.<exp>[.<sub>]`). */
export function studioSessionSigningInput(exp: number, sub?: string): string {
  return sub ? `${STUDIO_SESSION_PREFIX}${exp}.${sub}` : `${STUDIO_SESSION_PREFIX}${exp}`;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Konstantzeit-Vergleich zweier Hex-Signaturen. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Erzeugt ein Session-Token (Portal-Worker und Tests). */
export async function signStudioSession(
  secret: string,
  opts: { nowSec?: number; ttlS?: number; sub?: string } = {},
): Promise<string> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = now + (opts.ttlS ?? STUDIO_SESSION_TTL_S);
  const signature = await hmacHex(secret, studioSessionSigningInput(exp, opts.sub));
  return buildStudioSessionToken(exp, signature, opts.sub);
}

/**
 * Prüft ein Session-Token: Format, Signatur und Ablauf. Gibt `false` zurück,
 * wenn irgendetwas nicht stimmt (kein Werfen — der Aufrufer entscheidet).
 */
export async function verifyStudioSession(
  token: string,
  secret: string,
  opts: { nowSec?: number } = {},
): Promise<boolean> {
  const value = String(token ?? '').trim();
  const key = String(secret ?? '').trim();
  if (!value.startsWith(STUDIO_SESSION_PREFIX) || !key) return false;

  const rest = value.slice(STUDIO_SESSION_PREFIX.length);
  // Zwei zulässige Formen: `v1.<exp>.<sig>` und `v1.<exp>.<sub>.<sig>`.
  // (Der erste Entwurf verlangte immer ein sub und lehnte damit jedes Token
  // ohne sub ab — vom Test tests/studioSession.test.ts aufgedeckt.)
  const parts = rest.split('.');
  if (parts.length < 2) return false;
  const signature = parts[parts.length - 1];
  const exp = Number(parts[0]);
  if (!Number.isInteger(exp) || exp <= 0) return false;
  const sub = parts.slice(1, -1).join('.');
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;

  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (exp <= now) return false; // abgelaufen

  const expected = await hmacHex(key, studioSessionSigningInput(exp, sub));
  return timingSafeEqualHex(expected.toLowerCase(), signature.toLowerCase());
}

/** Liest das `studio`-Cookie aus einem Cookie-Header (pur, testbar). */
export function studioTokenFromCookieHeader(cookieHeader: string): string {
  const m = String(cookieHeader ?? '').match(/(?:^|;\s*)studio=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

/** Ist der Wert ein Session-Token (nur Formprüfung, keine Signatur)? */
export function looksLikeStudioSession(token: string): boolean {
  return String(token ?? '').trim().startsWith(STUDIO_SESSION_PREFIX);
}
