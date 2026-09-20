/**
 * audioMONASTRY · Session-Kennzeichen für REST-Aufrufe (F5-Fix)
 * ============================================================
 * Warum: Der Server zählte Rate-Limits bisher am **Studio-Token** – und der ist
 * bei allen Beteiligten derselbe Master-Token. Die vier Nutzer einer Session
 * (und jeder Skript-Aufruf) teilten sich damit EIN Budget von 60 Requests/Minute;
 * ein einzelner Client konnte alle anderen aussperren (live gemessen 2026-09-20:
 * 75 Aufrufe -> exakt 60×200 + 15×429).
 *
 * Der Server bildet seinen Limiter-Schlüssel jetzt aus einer Nutzer-/Session-
 * Identität (server/rateLimitKeys.ts). Diese Datei liefert das clientseitige
 * Kennzeichen dafür: die ohnehin vorhandene Kollaborations-UserId der Session
 * (`WebRTCManager.userId`, wird auch im Socket-Handshake als `join-session`
 * gemeldet). Sie ist pro Browser/Tab stabil und unterscheidet genau die Fälle,
 * in denen eine IP-Trennung versagt (mehrere Nutzer hinter derselben NAT-IP).
 *
 * Rein und abhängigkeitsfrei (kein `window`, kein `process` – das Kennzeichen
 * muss auch in Workers/Tests funktionieren).
 */

/** Header, den der Server als Session-Kennzeichen liest (server/rateLimitKeys.ts). */
export const SESSION_IDENTITY_HEADER = 'x-session-id';

/** Server-seitig erlaubter Zeichenvorrat/Länge (identisch gespiegelt). */
const SESSION_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/;

let sessionIdentity = '';

/**
 * Setzt das Kennzeichen der laufenden Session. Mehrfachaufrufe sind erlaubt
 * (letzter Wert gewinnt) – ein Wechsel passiert nur beim Neuverbinden.
 * Ungültige Werte werden ignoriert, damit nie ein unbrauchbares Kennzeichen
 * gesendet wird (der Server fällt dann auf die IP zurück).
 */
export function setSessionIdentity(identity: string): void {
  const value = String(identity ?? '').trim();
  if (SESSION_IDENTITY_PATTERN.test(value)) sessionIdentity = value;
}

/** Aktuelles Kennzeichen ('' wenn keins gesetzt ist). */
export function getSessionIdentity(): string {
  return sessionIdentity;
}

/**
 * Header für einen API-Aufruf. Leer, solange kein Kennzeichen gesetzt ist –
 * `fetch` verhält sich dann exakt wie vorher (Cookies/Token unverändert).
 */
export function sessionIdentityHeaders(): Record<string, string> {
  return sessionIdentity ? { [SESSION_IDENTITY_HEADER]: sessionIdentity } : {};
}
