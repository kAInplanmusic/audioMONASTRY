/**
 * audioMONASTRY · WebRTC-/ICE-Konfiguration serverseitig (COLLAB-P0-003, F6)
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
 *
 * F6 (2026-09-20) ergänzt zwei Felder, weil der Client den Zustand nicht erraten
 * darf:
 *
 *   * `turn`  – ist ein Relay WIRKLICH konfiguriert (`available`) oder nur STUN?
 *               Ohne TURN-URLs/Secret ist `available:false` samt `reason`; ein
 *               stilles „ok" ohne `turn:`-Eintrag wäre der Fehler aus F6.
 *   * `sfu`   – unter welcher URL erreicht der Client die SFU-Signalisierung?
 *               Vorher verband der Client **same-origin** `/sfu-signaling` und
 *               traf auf dem App-Knoten (ENABLE_SFU=0) die SPA-HTML-Auslieferung.
 *               Die URL kommt aus `SFU_SIGNALING_URL`; ohne sie ist `ready:false`
 *               statt eines Scheinerfolgs.
 */
import { createHmac } from 'node:crypto';
import { buildIceServers, PUBLIC_STUN_URLS, type IceServerConfig } from '../src/core/transport/iceConfig';

export const DEFAULT_TURN_TTL_SECONDS = 3600;

/** Pfad der SFU-Signalisierung (socket.io) – identisch in Client und Server. */
export const DEFAULT_SFU_SIGNALING_PATH = '/sfu-signaling';

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
  /** F6: Ist ein Relay wirklich konfiguriert (und warum nicht)? */
  turn: TurnInfo;
  /** F6: Erreichbarkeit der SFU-Signalisierung (nie same-origin geraten). */
  sfu: SfuSignalingInfo;
}

/** Zustand des TURN-Relays – ehrlich, wenn nichts konfiguriert ist. */
export interface TurnInfo {
  available: boolean;
  urls: string[];
  ttlSeconds: number;
  /** Klartextgrund NUR, wenn `available` false ist. */
  reason?: string;
}

/** Zustand/Adresse der SFU-Signalisierung (F6). */
export interface SfuSignalingInfo {
  /** Läuft auf DIESEM Knoten eine SFU (`ENABLE_SFU=1`)? Nur informativ. */
  enabled: boolean;
  /** Absolute Basis-URL der SFU (http/https) oder `null`, wenn nicht gesetzt. */
  url: string | null;
  /** socket.io-Pfad der Signalisierung (Default `/sfu-signaling`). */
  path: string;
  /** true, sobald eine absolute URL konfiguriert ist (Client kann verbinden). */
  ready: boolean;
  /** Klartextgrund NUR, wenn `ready` false ist. */
  reason?: string;
}

const isHttpUrl = (value: string): boolean => /^https?:\/\/[^\s/]+/i.test(value);

/**
 * Normalisiert eine SFU-Basis-URL: trimmt, entfernt trailing slashes und lehnt
 * alles ab, was kein http(s)-Ursprung ist (`/sfu-signaling` als relativer Pfad
 * wäre genau der same-origin-Fehler aus F6 – hier absichtlich kein Treffer).
 */
export function normalizeSfuSignalingUrl(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const trimmed = value.replace(/\/+$/, '');
  if (!isHttpUrl(trimmed)) return null;
  return trimmed;
}

/** socket.io-Pfad: muss mit `/` beginnen, sonst bleibt der Default stehen. */
export function normalizeSfuSignalingPath(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value.startsWith('/') || value.startsWith('//')) return DEFAULT_SFU_SIGNALING_PATH;
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.length > 1 ? trimmed : DEFAULT_SFU_SIGNALING_PATH;
}

/** Baut den SFU-Block aus der Umgebung (Client-Vertrag für F6). */
export function resolveSfuSignaling(
  env: Record<string, string | undefined> = process.env,
): SfuSignalingInfo {
  const enabled = String(env.ENABLE_SFU ?? '').trim() === '1';
  const url = normalizeSfuSignalingUrl(env.SFU_SIGNALING_URL);
  const path = normalizeSfuSignalingPath(env.SFU_SIGNALING_PATH);
  if (url === null) {
    const raw = String(env.SFU_SIGNALING_URL ?? '').trim();
    return {
      enabled,
      url: null,
      path,
      ready: false,
      reason: raw
        ? `SFU_SIGNALING_URL ist keine absolute http(s)-URL: "${raw.slice(0, 60)}"`
        : 'SFU_SIGNALING_URL nicht gesetzt – kein SFU-Pfad für den Client',
    };
  }
  return { enabled, url, path, ready: true };
}

/** Baut den TURN-Block (Relay verfügbar? mit welcher TTL?). */
export function resolveTurnInfo(
  env: Record<string, string | undefined> = process.env,
  ttlSeconds = DEFAULT_TURN_TTL_SECONDS,
): TurnInfo {
  const urls = splitList(env.TURN_URLS).filter((u) => /^turns?:/i.test(u));
  const secret = String(env.TURN_STATIC_AUTH_SECRET ?? '').trim();
  if (urls.length === 0) {
    return { available: false, urls: [], ttlSeconds, reason: 'TURN_URLS nicht gesetzt – nur STUN aktiv' };
  }
  if (!secret) {
    return {
      available: false,
      urls,
      ttlSeconds,
      reason: 'TURN_STATIC_AUTH_SECRET fehlt – ohne Secret werden keine Credentials ausgegeben',
    };
  }
  return { available: true, urls, ttlSeconds };
}

/**
 * Baut die Antwort für `/api/webrtc-config`. Ohne TURN-URLs oder Secret bleibt
 * es bei STUN (ehrlich: `turn.available=false` plus Grund, kein Relay).
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
    turn: resolveTurnInfo(env, ttlSeconds),
    sfu: resolveSfuSignaling(env),
  };
}
