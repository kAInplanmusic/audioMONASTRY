/**
 * audioMONASTRY · WebRTC-/ICE-Konfiguration serverseitig (COLLAB-P0-003)
 * =====================================================================
 * Der Client hat ICE-Server bisher hartkodiert (nur STUN). Hier entsteht die
 * autoritative Konfiguration für `GET /api/webrtc-config`:
 *
 *   * öffentliche STUN-Fallbacks immer,
 *   * eigener STUN optional (`ICE_STUN_URLS`),
 *   * TURN optional (`TURN_URLS` + `TURN_STATIC_AUTH_SECRET`) mit **kurzlebigen**
 *     Credentials nach dem coturn-REST-Schema (`use-auth-secret`):
 *
 *         username   = "<expiry-unix>:<userId>"
 *         credential = base64(HMAC-SHA1(username, static-auth-secret))
 *
 * Damit liegt das langlebige Secret nur auf dem Server; der Client bekommt pro
 * Anfrage ein zeitlich begrenztes Paar. Der coturn-Dienst in `services/turn`
 * ist bereits mit `use-auth-secret` + `static-auth-secret` konfiguriert.
 */
import { createHmac } from 'node:crypto';
import { buildIceServers, PUBLIC_STUN_URLS, type IceServerConfig } from '../src/core/transport/iceConfig';

export const DEFAULT_TURN_TTL_SECONDS = 3600;

export interface TurnCredentials {
  username: string;
  credential: string;
  /** Unix-Sekunden, ab denen die Credentials ablaufen. */
  expiry: number;
}

/** coturn-REST-Credentials (kurzlebig, deterministisch bei injiziertem `now`). */
export function createTurnCredentials(
  secret: string,
  userId: string,
  ttlSeconds = DEFAULT_TURN_TTL_SECONDS,
  now = Date.now(),
): TurnCredentials {
  const s = String(secret ?? '').trim();
  if (!s) throw new Error('TURN_STATIC_AUTH_SECRET fehlt');
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.floor(ttlSeconds) : DEFAULT_TURN_TTL_SECONDS;
  const expiry = Math.floor(now / 1000) + ttl;
  const username = `${expiry}:${String(userId ?? '').trim() || 'anonymous'}`;
  const credential = createHmac('sha1', s).update(username).digest('base64');
  return { username, credential, expiry };
}

/** `a,b , c` → `['a','b','c']`. */
export function splitList(value: string | undefined | null): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface WebRtcConfigResponse {
  iceServers: IceServerConfig[];
  ttlSeconds: number;
  generatedAt: number;
}

/**
 * Baut die Antwort für `/api/webrtc-config`. Ohne TURN-URLs oder Secret bleibt
 * es bei STUN (ehrlich: kein Relay, strikte Firewalls brauchen die Konfiguration).
 */
export function buildWebRtcConfigResponse(
  env: Record<string, string | undefined> = process.env,
  opts: { userId?: string; now?: number } = {},
): WebRtcConfigResponse {
  const now = opts.now ?? Date.now();
  const stunUrls = [...splitList(env.ICE_STUN_URLS), ...PUBLIC_STUN_URLS];
  const turnUrls = splitList(env.TURN_URLS);
  const secret = (env.TURN_STATIC_AUTH_SECRET ?? '').trim();
  const ttlSeconds = Number(env.TURN_TTL_SECONDS) > 0 ? Math.floor(Number(env.TURN_TTL_SECONDS)) : DEFAULT_TURN_TTL_SECONDS;

  let turnUsername: string | undefined;
  let turnCredential: string | undefined;
  if (turnUrls.length > 0 && secret) {
    const creds = createTurnCredentials(secret, opts.userId ?? 'anonymous', ttlSeconds, now);
    turnUsername = creds.username;
    turnCredential = creds.credential;
  }

  return {
    iceServers: buildIceServers({ stunUrls, turnUrls, turnUsername, turnCredential }),
    ttlSeconds,
    generatedAt: now,
  };
}
