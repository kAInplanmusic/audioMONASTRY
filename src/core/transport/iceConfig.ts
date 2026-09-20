/**
 * audioMONASTRY · ICE-Konfiguration (COLLAB-P0-003)
 * =================================================
 * Reine, testbare Bausteine für die WebRTC-Härtung:
 *
 *   * `buildIceServers`   – STUN + (optional) TURN zu einer validen ICE-Liste
 *                           zusammenführen, leere/doppelte Einträge verwerfen.
 *   * `parseIceConfigResponse` – die Antwort von `GET /api/webrtc-config`
 *                           prüfen und normalisieren (kein stiller Müll).
 *   * `hasRelayServer`    – gibt es überhaupt einen TURN-Relay (Firewall-Fall)?
 *
 * Bewusst ohne WebRTC-/DOM-API: die Konfiguration ist damit ohne Browser
 * prüfbar, und der Client kann sie erst nach dem Fetch an `RTCPeerConnection`
 * übergeben.
 */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfigInput {
  /** STUN-URLs (i. d. R. öffentliche Fallbacks + optional eigener STUN). */
  stunUrls?: readonly string[];
  /** TURN-URLs (Relay für strikte Firewalls). */
  turnUrls?: readonly string[];
  /** Kurzlebiger TURN-Benutzer (coturn REST: `<expiry>:<userId>`). */
  turnUsername?: string;
  /** Kurzlebiger TURN-Credential (HMAC-SHA1, base64). */
  turnCredential?: string;
}

/** Öffentliche STUN-Fallbacks (Redundanz, ohne Credentials). */
export const PUBLIC_STUN_URLS = [
  'stun:stun.services.mozilla.com',
  'stun:stun.cloudflare.com:3478',
] as const;

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function normalizeUrls(urls: readonly string[] | undefined): string[] {
  if (!Array.isArray(urls)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!isNonEmptyString(url)) continue;
    const trimmed = url.trim();
    // Nur echte ICE-Schemata akzeptieren (kein "http://…" als STUN).
    if (!/^(stun|stuns|turn|turns):/i.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Baut die ICE-Server-Liste. STUN kommt zuerst (billig, niedrige Latenz), TURN
 * nur mit vollständigen Credentials (sonst würde der Browser die Verbindung
 * ohne Relay aufbauen und in strikten Netzen scheitern).
 */
export function buildIceServers(input: IceConfigInput): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  const stun = normalizeUrls(input.stunUrls);
  if (stun.length > 0) servers.push({ urls: stun });
  const turn = normalizeUrls(input.turnUrls);
  if (turn.length > 0 && isNonEmptyString(input.turnUsername) && isNonEmptyString(input.turnCredential)) {
    servers.push({ urls: turn, username: input.turnUsername.trim(), credential: input.turnCredential });
  }
  return servers;
}

/** Gibt es einen Relay-Kandidaten (`turn:`/`turns:`)? */
export function hasRelayServer(servers: readonly IceServerConfig[]): boolean {
  return servers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => /^turns?:/i.test(String(u)));
  });
}

export interface ParsedIceConfig {
  iceServers: IceServerConfig[];
  ttlSeconds: number;
  generatedAt: number;
  /** F6: Ist ein Relay konfiguriert (und warum nicht)? Fehlt = alte Antwort. */
  turn?: { available: boolean; urls: string[]; reason: string };
  /** F6: Adresse der SFU-Signalisierung (null = keine konfiguriert). */
  sfu?: { url: string | null; path: string; ready: boolean; reason: string };
}

/**
 * Prüft die Server-Antwort. Wirft bei kaputtem Inhalt (kein stiller Fallback),
 * damit der Aufrufer bewusst auf die statische Konfiguration zurückfallen kann.
 */
export function parseIceConfigResponse(data: unknown): ParsedIceConfig {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { iceServers?: unknown }).iceServers)) {
    throw new Error('webrtc-config: iceServers fehlt/ist kein Array');
  }
  const raw = (data as { iceServers: unknown[] }).iceServers;
  const iceServers: IceServerConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = Array.isArray(e.urls) ? e.urls : [e.urls];
    const normalized = normalizeUrls(urls as string[]);
    if (normalized.length === 0) continue;
    const server: IceServerConfig = { urls: normalized };
    if (isNonEmptyString(e.username) && isNonEmptyString(e.credential)) {
      server.username = e.username.trim();
      server.credential = e.credential;
    }
    iceServers.push(server);
  }
  if (iceServers.length === 0) throw new Error('webrtc-config: keine valide ICE-URL');
  const ttl = Number((data as { ttlSeconds?: unknown }).ttlSeconds);
  const generatedAt = Number((data as { generatedAt?: unknown }).generatedAt);
  const parsed: ParsedIceConfig = {
    iceServers,
    ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 0,
    generatedAt: Number.isFinite(generatedAt) ? generatedAt : 0,
  };

  // F6: Relay-Zustand ehrlich übernehmen (auch die Aussage "nur STUN"). Ein
  // fehlender Block (ältere Server-Version) fällt auf `hasRelayServer` zurück.
  const turnRaw = (data as { turn?: unknown }).turn;
  if (turnRaw && typeof turnRaw === 'object') {
    const t = turnRaw as { available?: unknown; urls?: unknown; reason?: unknown };
    parsed.turn = {
      available: t.available === true,
      urls: Array.isArray(t.urls) ? normalizeUrls(t.urls as string[]) : [],
      reason: isNonEmptyString(t.reason) ? t.reason.trim() : '',
    };
  } else {
    parsed.turn = {
      available: hasRelayServer(iceServers),
      urls: [],
      reason: hasRelayServer(iceServers) ? '' : 'Server liefert keinen turn:-Eintrag (nur STUN)',
    };
  }

  const sfuRaw = (data as { sfu?: unknown }).sfu;
  if (sfuRaw && typeof sfuRaw === 'object') {
    const s = sfuRaw as { url?: unknown; path?: unknown; ready?: unknown; reason?: unknown };
    const path = isNonEmptyString(s.path) && s.path.startsWith('/') ? s.path.trim() : '/sfu-signaling';
    parsed.sfu = {
      url: isNonEmptyString(s.url) ? s.url.trim().replace(/\/+$/, '') : null,
      path,
      ready: s.ready === true,
      reason: isNonEmptyString(s.reason) ? s.reason.trim() : '',
    };
  } else {
    parsed.sfu = { url: null, path: '/sfu-signaling', ready: false, reason: 'Server liefert keinen sfu-Block (F6)' };
  }

  return parsed;
}
