// ============================================================================
// WebRTC-Konfiguration für audioMONASTRY (P2: TURN/STUN-Routing)
// ----------------------------------------------------------------------------
// - Robustes fallback-basiertes ICE mit mehreren öffentlichen STUN-Diensten.
// - Optionaler eigener TURN-Server (z.B. Hetzner / `services/turn/`), per
//   VITE_TURN_* Umgebungsvariablen konfigurierbar.
// - Feature-Detect für warme Firewall-freie Verbindungen: dynamische ICEServer
//   ohne Credentials -> sendet zuerst ohne, fügt gezielt hinzu wenn nötig.
// ============================================================================

import { parseIceConfigResponse } from '../core/transport/iceConfig';
import { cacheServerSfuSignaling } from '../core/transport/sfuEndpoint';

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function readEnv(key: string): string | undefined {
  try {
    if (typeof import.meta !== 'undefined') {
      const val = (import.meta as any).env?.[key];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
  } catch {
    /* SSR/Node ohne import.meta.env */
  }
  try {
    if (typeof process !== 'undefined' && process.env && process.env[key]) {
      return process.env[key];
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

// --- Öffentliche, neutral betriebene STUN-Fallback-Server (Redundanz) ---
const PUBLIC_STUN = [
  'stun:stun.services.mozilla.com',
  'stun:stun.cloudflare.com:3478',
];

// Optionaler eigener STUN (z.B. lokaler/Hetzner-Edge). Über VITE_ICE_STUN setzen.
const customStun = readEnv('VITE_ICE_STUN');

function buildIceServers(): IceServer[] {
  const servers: IceServer[] = [];

  // 1) Eigener/Benutzerdefinierter STUN zuerst (niedrigste Latenz)
  if (customStun) {
    servers.push({ urls: customStun });
  }

  // 2) Öffentliche STUN-Fallbacks
  servers.push({ urls: PUBLIC_STUN });

  // 3) Optionale TURN-Server (mit Credentials) – für strikte Firewalls
  const turnUrl = readEnv('VITE_TURN_URL');
  const turnUsername = readEnv('VITE_TURN_USERNAME');
  const turnCredential = readEnv('VITE_TURN_CREDENTIAL');
  if (turnUrl && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return servers;
}

export const rtcConfig: RTCConfiguration = {
  iceServers: buildIceServers(),
  iceCandidatePoolSize: 5,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

// Hilfskonstrukt: erlaubt späteren Add-TURN zur Laufzeit (z.B. nach
// erfolgreichem Handshake-Backoff), falls ICE über die anfängliche
// Konfiguration nicht durchkommt.
export function addTurnServer(turn: IceServer): void {
  const cfg = rtcConfig as { iceServers?: IceServer[] };
  if (!cfg.iceServers) cfg.iceServers = [];
  cfg.iceServers.push(turn);
}

/**
 * COLLAB-P0-003: holt die autoritative ICE-Konfiguration vom Server
 * (`GET /api/webrtc-config`, inkl. kurzlebiger TURN-Credentials) und übernimmt
 * sie. Schlägt der Abruf fehl, bleibt die statische STUN-Konfiguration aktiv
 * (ehrlich: ohne Relay), der Aufrufer bekommt `false` zurück.
 *
 * F6: Zusätzlich wird der `sfu`-Block übernommen (Adresse der SFU-Signalisierung)
 * und der Relay-Zustand gemeldet. Ohne TURN-Relay ist der Ton über strikte
 * Firewalls/NAT nicht tragfähig – das wird EINMAL laut gesagt, statt still zu
 * scheitern.
 */
export async function refreshIceConfig(
  userId?: string,
  fetchImpl: typeof fetch | undefined = typeof fetch !== 'undefined' ? fetch : undefined,
): Promise<boolean> {
  if (!fetchImpl) return false;
  try {
    const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    const resp = await fetchImpl(`/api/webrtc-config${query}`, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const parsed = parseIceConfigResponse(await resp.json());
    const cfg = rtcConfig as { iceServers?: IceServer[] };
    cfg.iceServers = parsed.iceServers as IceServer[];
    // F6: SFU-Adresse für den Transport zwischenspeichern (kein zweiter Abruf).
    cacheServerSfuSignaling(parsed.sfu ? { url: parsed.sfu.url, path: parsed.sfu.path, ready: parsed.sfu.ready, reason: parsed.sfu.reason } : null);
    reportRelayAndSfuState(parsed);
    return true;
  } catch (e) {
    // Erwarteter Fallback (kein Token/kein TURN konfiguriert) – daher debug und
    // nicht warn: die statische STUN-Konfiguration bleibt aktiv.
    console.debug('[webrtc] ICE-Konfiguration nicht vom Server geladen – statisches STUN aktiv:', (e as Error).message);
    return false;
  }
}

let relayStateReported = false;

/**
 * Meldet den Relay-/SFU-Zustand aus der Serverantwort einmalig laut. Der Client
 * erfährt hier, ob überhaupt ein `turn:`-Relay existiert und ob eine
 * SFU-Signalisierungsadresse konfiguriert ist – beides war in F6 der blinde
 * Fleck (nur STUN, SFU same-origin).
 */
function reportRelayAndSfuState(parsed: ReturnType<typeof parseIceConfigResponse>): void {
  if (relayStateReported) return;
  relayStateReported = true;
  if (parsed.turn && !parsed.turn.available) {
    console.warn(
      '[webrtc] kein TURN-Relay konfiguriert – nur STUN aktiv '
      + `(${parsed.turn.reason || 'Grund unbekannt'}). Verbindungen über strikte NATs/Firewalls können scheitern.`,
    );
  } else if (parsed.turn?.available) {
    console.info(`[webrtc] TURN-Relay aktiv (${parsed.turn.urls.join(', ') || 'Server-Liste'}), TTL ${parsed.ttlSeconds}s.`);
  }
  if (parsed.sfu && !parsed.sfu.ready) {
    console.warn(`[webrtc] keine SFU-Signalisierungsadresse konfiguriert (${parsed.sfu.reason || 'Grund unbekannt'}).`);
  }
}
