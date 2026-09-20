/**
 * audioMONASTRY · Rate-Limit-Identität (F5-Fix)
 * =============================================
 * Warum: `apiLimiter`/`agentLimiter`/`uploadChunkLimiter`/`expensiveLimiter`
 * nahmen bisher den **Studio-Token selbst** als Schlüssel
 * (`studioKeyGenerator = studioTokenFromRequest(req) || ip`). Der Master-Token
 * ist aber bei allen Beteiligten DERSELBE: die vier Browser-Nutzer einer
 * Session, das Portal, die Monitoring-Skripte und die Flotten-Aufrufe teilten
 * sich damit EIN Budget von 60 Requests/Minute. Live belegt am 2026-09-20 an
 * der externen Instanz: 75 sequenzielle Aufrufe -> exakt 60×200 + 15×429 mit
 * `Retry-After: 56`. Ein einzelner Client konnte so allen anderen den Zugang
 * sperren (und umgekehrt).
 *
 * Diese Datei liefert die Nutzer-/Session-Identität als Schlüssel:
 *
 *   1. `sess:<hash>` – kurzlebiges, SIGNIERTES Portal-Session-Token
 *      (`v1.<exp>[.<sub>].<sig>`, siehe src/core/session/studioSession.ts).
 *      Bevorzugt wird das `sub`-Merkmal (stabile Session-Identität), sonst das
 *      Token selbst – beides ist vom Portal ausgestellt und nicht fälschbar.
 *   2. `sid:<hash>` – vom Client gemeldetes Session-Kennzeichen
 *      (`x-session-id`, z. B. die Kollaborations-UserId aus dem
 *      Socket-Handshake, `WebRTCManager.userId`). Das ist NICHT signiert,
 *      hilft aber genau in dem Fall, in dem IP-Trennung versagt: mehrere Nutzer
 *      hinter derselben NAT-/Proxy-IP. Der Limiter läuft NACH der Auth-Middleware
 *      – ohne gültigen Studio-Token kommt ein Aufruf hier nie an.
 *   3. `ip:<ip>` – Fallback wie bisher. Damit bleiben tokenlose Aufrufe
 *      (Monitoring, Skripte, Flotte) und Token-lose Testreihen unverändert
 *      getrennt. IPv6 wird über `ipKeyGenerator` aus express-rate-limit
 *      normalisiert (ein Client darf sich nicht per IPv6-Präfix-Wechsel ein
 *      neues Budget holen).
 *
 * Der MASTER-Token ist bewusst KEIN Schlüssel mehr – er identifiziert keinen
 * Nutzer. Wer ihn ohne Session-Kennzeichen benutzt, landet auf seinem IP-Budget.
 *
 * Keine Secrets im Klartext im Speicher/Log: es werden nur SHA-256-Kürzel
 * verwendet (32 Hex-Zeichen), die Identität selbst verlässt diese Datei nicht.
 *
 * ── Grenzen (bewusst offengelegt, nicht wegdefiniert) ─────────────────────────
 * 1. Session-Token OHNE `sub`: gekeyt wird dann das ganze Token. Das Portal
 *    (`services/portal-worker`, `studioSessionToken()`) signiert derzeit
 *    ausschließlich `v1.<exp>` – mit `STUDIO_SESSION_MODE=session` bekommt jeder
 *    Browser je Auslieferung ein NEUES Token (TTL 900 s) und damit ein frisches
 *    Budget. Für ein stabiles Budget müsste das Portal beim Signieren ein
 *    `sub` (Session-/Nutzerkennung) mitschicken. Bis dahin trägt die Trennung
 *    im Browser der Pfad 2 (`x-session-id`), weil der Client ihn mitschickt.
 * 2. `x-session-id` ist NICHT signiert, sondern nur hinter der Auth gültig:
 *    ein authentifizierter Client kann sein Budget durch Wechsel des
 *    Kennzeichens vervielfachen. Offener Punkt: das Kennzeichen an eine
 *    serverseitig bekannte Session binden (z. B. Kollaborations-UserId aus dem
 *    Realtime-Hub) oder je IP die Zahl unterschiedlicher Kennzeichen begrenzen.
 * 3. In Dev/Test (`AUDIOMONASTRY_DEV_NO_AUTH`/VITEST) ist die API offen; das
 *    Limit ist dort keine Sicherheitsgrenze, nur eine Lastbremse.
 * Bewusst NICHT umgesetzt: zusätzliche Sperrlisten/Nachverfolgung je IP – der
 * belegte Schaden war ein GETEILTES Budget legitimer Nutzer, und weitere
 * Mechanik wäre unbelegt und latenzrelevant.
 */
import { createHash } from 'crypto';
import { STUDIO_SESSION_PREFIX, looksLikeStudioSession } from '../src/core/session/studioSession';

/** Header, mit dem ein Client sein Session-/Kollaborations-Kennzeichen meldet. */
export const SESSION_IDENTITY_HEADER = 'x-session-id';

/** Kürzel einer Identität – stabil, kurz, ohne Rückschluss auf den Token. */
export function hashIdentity(value: string): string {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Ist der Wert ein Portal-Session-Token (nur Formprüfung)?
 * Die Signatur prüft bereits die Auth-Middleware (asynchron, VOR dem Limiter);
 * hier genügt deshalb die Form, um Master-Token und Session-Token zu trennen.
 *
 * Bewusst dieselbe Funktion wie in der Auth (`looksLikeStudioSession`) und
 * derselbe Präfix-Konstante aus `studioSession.ts`: zwei eigene Kopien würden
 * bei einer Formatänderung still auseinanderlaufen – der Limiter fiele dann
 * lautlos auf das IP-Budget zurück, ohne dass ein Test das bemerkt.
 */
export function isStudioSessionToken(token: string): boolean {
  return looksLikeStudioSession(token);
}

/**
 * Liest das `sub`-Merkmal aus einem Session-Token `v1.<exp>[.<sub>].<sig>`.
 * Leer, wenn kein `sub` enthalten ist (dann ist das Token selbst die Identität).
 */
export function studioSessionSubject(token: string): string {
  const value = String(token ?? '').trim();
  if (!value.startsWith(STUDIO_SESSION_PREFIX)) return '';
  const parts = value.slice(STUDIO_SESSION_PREFIX.length).split('.');
  if (parts.length < 3) return '';
  return parts.slice(1, -1).join('.');
}

/**
 * Liest ein vom Client gemeldetes Session-Kennzeichen. Streng begrenzt
 * (Länge/Zeichenvorrat), damit der Limiter-Speicher nicht mit beliebigen
 * Schlüsseln geflutet werden kann; ungültige Werte werden ignoriert (Fallback
 * auf die nächste Stufe der Kette).
 */
export function declaredSessionId(headerValue: unknown): string {
  const raw = String(headerValue ?? '').trim();
  if (!raw || raw.length > 64) return '';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/.test(raw) ? raw : '';
}

export interface RateLimitIdentityInput {
  /** Studio-Token der Anfrage (Master oder Session), wie von der Auth gelesen. */
  token?: string;
  /** Wert des `x-session-id`-Headers (optional). */
  sessionId?: string;
  /** Client-IP (nur Fallback). */
  ip?: string;
}

/**
 * Bildet den Limiter-Schlüssel.
 *
 * `ipFallback` wird injiziert, damit die IPv6-Normalisierung von
 * express-rate-limit (`ipKeyGenerator`) greift und diese Datei rein/testbar
 * bleibt.
 */
export function resolveRateLimitIdentity(
  input: RateLimitIdentityInput,
  ipFallback: (ip: string) => string,
): string {
  const token = String(input.token ?? '').trim();
  if (token && isStudioSessionToken(token)) {
    const subject = studioSessionSubject(token);
    return `sess:${hashIdentity(subject || token)}`;
  }
  const declared = declaredSessionId(input.sessionId);
  if (declared) return `sid:${hashIdentity(declared)}`;
  // Kein Nutzer-Merkmal: IP (bisheriges Verhalten fuer tokenlose Aufrufe).
  return ipFallback(String(input.ip ?? ''));
}
