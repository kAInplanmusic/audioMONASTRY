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

export const API_ORIGIN = resolveOrigin(
  typeof import.meta !== 'undefined' ? import.meta.env.VITE_API_BASE_URL : undefined,
  'http://localhost:8080',
);

// Always prefer relative `/api` (same origin) when no explicit origin was given.
export const API_BASE_URL = API_ORIGIN ? `${API_ORIGIN}/api` : '/api';

// Backend endpoints default to SAME-ORIGIN (relative paths). In dev, where the
// app is served by Vite (port 5173) and the Express backend runs on 8080, we
// use the absolute local backend so CORS/WS work out of the box.
export const SOCKET_IO_SIGNALING_URL =
  typeof window !== 'undefined' && !isLocalHost
    ? ''
    : (resolveOrigin(
        typeof import.meta !== 'undefined' ? import.meta.env.VITE_SOCKET_IO_SIGNALING_URL : undefined,
        // Dev-Default = derselbe integrierte Server (Port 8080), der das
        // WebRTC-Signaling auf dem Pfad /webrtc-signaling mitliefert.
        'http://localhost:8080',
      ) ?? '');

export const SIGNALING_WS_URL =
  typeof window !== 'undefined' && !isLocalHost
    ? ''
    : (resolveOrigin(
        typeof import.meta !== 'undefined' ? import.meta.env.VITE_SIGNALING_WS_URL : undefined,
        'ws://localhost:8080',
      ) ?? '');

export const SIGNALING_HTTP_URL =
  typeof window !== 'undefined' && !isLocalHost
    ? ''
    : (resolveOrigin(
        typeof import.meta !== 'undefined' ? import.meta.env.VITE_SIGNALING_HTTP_URL : undefined,
        'http://localhost:8080',
      ) ?? '');

export const SIGNALING_TRANSPORT_URL =
  typeof window !== 'undefined' && !isLocalHost
    ? ''
    : (resolveOrigin(
        typeof import.meta !== 'undefined' ? import.meta.env.VITE_SIGNALING_TRANSPORT_URL : undefined,
        'http://localhost:8080/webrtc-signaling',
      ) ?? '');
