/**
 * Runtime environment configuration.
 *
 * PORTABLE design:
 * - The app is served by the Express backend on the SAME origin. In production
 *   we therefore default to RELATIVE paths (`/api`, `/socket.io`) so the app
 *   works on any host (Hetzner, Cloud Run, Firebase Hosting via proxy, ...)
 *   without hardcoding a specific backend origin.
 * - For setups where the API lives on another host, set `VITE_API_BASE_URL`
 *   (and the VITE_SIGNALING_* vars) explicitly at build/deploy time.
 */

const trimTrailingSlash = (value: string) => {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') end--;
  return value.slice(0, end);
};

const browserHostname = typeof window !== 'undefined' ? window.location.hostname : '';
const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(browserHostname);

/**
 * Origin, unter dem die Seite wirklich geladen wurde.
 *
 * BEFUND 2026-11-05: Der lokale Rueckfall war hart `http://localhost:8080`.
 * Wird die App ueber `127.0.0.1` oder eine LAN-IP geoeffnet, zeigt der Client
 * damit auf einen fremden Host: `localhost` loest zuerst auf `::1` auf, der
 * Server lauscht IPv4-only -> keine Socket-Verbindung, kein Mitglied in der
 * Session, kein Halter fuer mixerMONK (Pult gesperrt). Deshalb: der lokale
 * Default ist die eigene Origin der Seite, nicht ein festes localhost.
 */
const pageOrigin = (): string => {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return 'http://localhost:8080';
};

/** Dasselbe als WebSocket-Origin (`http` -> `ws`, `https` -> `wss`). */
const pageWsOrigin = (): string => pageOrigin().replace(/^http/, 'ws');

/**
 * Returns the origin to use for a given service.
 * - Explicitly configured value wins (trimmed).
 * - On localhost we fall back to the local dev backend.
 * - In production we fall back to `null` → signal "same origin / relative".
 */
const resolveOrigin = (
  configuredValue: string | undefined,
  localDefault: string,
): string | null => {
  if (configuredValue && configuredValue.trim() !== '') {
    return trimTrailingSlash(configuredValue);
  }
  if (isLocalHost) return localDefault;
  return null; // same origin
};

const API_ORIGIN = resolveOrigin(
  typeof import.meta !== 'undefined' ? import.meta.env.VITE_API_BASE_URL : undefined,
  pageOrigin(),
);

// Always prefer relative `/api` (same origin) when no explicit origin was given.
export const API_BASE_URL = API_ORIGIN ? `${API_ORIGIN}/api` : '/api';

/**
 * Läuft der Code im Vite-Dev-Build? Einzige erlaubte Stelle für `import.meta.env`
 * neben `config/webrtc.ts` (Boundary-Regel, scripts/validate-interface-boundaries.mjs).
 * Wird u. a. vom Audit-Messhaken (`testing/audioProbe.ts`) gebraucht, der NUR im
 * Dev-Build geladen werden darf.
 */
export const IS_DEV_BUILD: boolean =
  typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);

// Backend endpoints default to SAME-ORIGIN (relative paths). In dev, where the
// app is served by Vite (port 5173) and the Express backend runs on 8080, we
// use the absolute local backend so CORS/WS work out of the box.
export const SOCKET_IO_SIGNALING_URL =
  typeof window !== 'undefined' && !isLocalHost
    ? ''
    : (resolveOrigin(
        typeof import.meta !== 'undefined' ? import.meta.env.VITE_SOCKET_IO_SIGNALING_URL : undefined,
        // Dev-Default = derselbe integrierte Server, der das WebRTC-Signaling
        // auf dem Pfad /webrtc-signaling mitliefert - unter der Origin, unter
        // der die Seite geladen wurde (127.0.0.1, localhost, LAN-IP, Port egal).
        pageOrigin(),
      ) ?? '');

export const SIGNALING_WS_URL =
  typeof window !== 'undefined' && !isLocalHost
    ? ''
    : (resolveOrigin(
        typeof import.meta !== 'undefined' ? import.meta.env.VITE_SIGNALING_WS_URL : undefined,
        pageWsOrigin(),
      ) ?? '');

export const SIGNALING_HTTP_URL =
  typeof window !== 'undefined' && !isLocalHost
    ? ''
    : (resolveOrigin(
        typeof import.meta !== 'undefined' ? import.meta.env.VITE_SIGNALING_HTTP_URL : undefined,
        pageOrigin(),
      ) ?? '');

export const SIGNALING_TRANSPORT_URL =
  typeof window !== 'undefined' && !isLocalHost
    ? ''
    : (resolveOrigin(
        typeof import.meta !== 'undefined' ? import.meta.env.VITE_SIGNALING_TRANSPORT_URL : undefined,
        `${pageOrigin()}/webrtc-signaling`,
      ) ?? '');

/**
 * Legacy-HTTP-Signaling (`POST {SIGNALING_HTTP_URL}/offer`) nur, wenn ein
 * Operator es **explizit** konfiguriert hat. Der aktuelle Pfad läuft über
 * socket.io (`/webrtc-signaling`); der Server hat keine `/offer`-Route, daher
 * erzeugte der same-origin-Default bei jedem Start einen 404.
 */
export const SIGNALING_HTTP_EXPLICIT =
  typeof import.meta !== 'undefined'
    ? Boolean(String(import.meta.env.VITE_SIGNALING_HTTP_URL ?? '').trim())
    : false;

/**
 * Basis-URL der SFU-Signalisierung (F6). Nur der ausdrücklich konfigurierte Wert
 * zählt – hier gibt es bewusst KEINEN same-origin-Rückfall: auf dem App-Knoten
 * läuft keine SFU (`ENABLE_SFU=0`), eine same-origin-Verbindung landet in der
 * SPA-Auslieferung. Die autoritative Quelle zur Laufzeit ist
 * `/api/webrtc-config` (`sfu.url`); `VITE_SFU_URL` ist der Build-Zeit-Notausgang
 * für Setups, in denen die App die Config nicht erreicht.
 */
export const SFU_SIGNALING_URL: string | null = (() => {
  const configured = typeof import.meta !== 'undefined'
    ? String(import.meta.env.VITE_SFU_URL ?? '').trim()
    : '';
  return configured === '' ? null : configured;
})();
