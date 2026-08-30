// ============================================================================
// WebRTC-Konfiguration für audioMONASTRY (P2: TURN/STUN-Routing)
// ----------------------------------------------------------------------------
// - Robustes fallback-basiertes ICE mit mehreren öffentlichen STUN-Diensten.
// - Optionaler eigener TURN-Server (z.B. Hetzner / `services/turn/`), per
//   VITE_TURN_* Umgebungsvariablen konfigurierbar.
// - Feature-Detect für warme Firewall-freie Verbindungen: dynamische ICEServer
//   ohne Credentials -> sendet zuerst ohne, fügt gezielt hinzu wenn nötig.
// ============================================================================

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
