/**
 * audioMONASTRY · SFU-Signalisierungsziel des Clients (F6)
 * ========================================================
 * Befund F6 (2026-09-20): Der Client verband die Mediasoup-Signalisierung
 * **same-origin** (`io({ path: '/sfu-signaling' })`). Auf dem App-Knoten, wo
 * `ENABLE_SFU` leer ist, landete die socket.io-Anfrage damit in der
 * SPA-Auslieferung – der Client bekam HTML statt einer Signalisierung und der
 * Fehler war nur ein generisches „xhr poll error". Die SFU-Adresse muss deshalb
 * konfigurierbar sein und aus einer autoritativen Quelle kommen.
 *
 * Reihenfolge (bewusst OHNE same-origin-Rückfall – genau der war der Fehler):
 *
 *   1. `SFU_SIGNALING_URL`/`sfu.url` aus `GET /api/webrtc-config` (Server),
 *   2. `VITE_SFU_URL` (Build-Zeit, z. B. eigener SFU-Host),
 *   3. sonst: KEIN Ziel. Der Aufrufer bekommt `null` und eine Begründung, damit
 *      er den Fehler sichtbar meldet statt in die App-HTML zu verbinden.
 *
 * Reine Rechen-/Prüffunktionen, kein WebRTC/DOM – damit ohne Browser testbar.
 * Kein `process`-Zugriff (browserSafeModules-Wächter); die Build-Zeit-Variable
 * kommt aus der Konfigurationsschicht (`src/config/runtime.ts`), damit der
 * Import.meta-Zugriff dort bleibt, wo er hingehört.
 */
import { SFU_SIGNALING_URL } from '../../config/runtime';

/** Ein aufgelöstes Signaling-Ziel (absolute Basis-URL + socket.io-Pfad). */
export interface SfuSignalingTarget {
  /** Absolute Basis-URL, z. B. `https://sfu.example` oder `http://1.2.3.4`. */
  url: string;
  /** socket.io-Pfad, z. B. `/sfu-signaling`. */
  path: string;
  /** Woher das Ziel kommt (Diagnose/Log). */
  source: 'server' | 'vite' | 'explicit';
}

/** Warum kein Ziel aufgelöst werden konnte. */
export interface SfuSignalingResolution {
  target: SfuSignalingTarget | null;
  reason: string;
}

export const DEFAULT_SFU_SIGNALING_PATH = '/sfu-signaling';

/** Fehler mit klarem Klartext (statt generischem socket.io-„xhr poll error"). */
export class SfuSignalingNotConfiguredError extends Error {
  readonly code = 'sfu-signaling-not-configured';
  constructor(reason: string) {
    super(
      'SFU-Signalisierung nicht erreichbar: keine SFU-Adresse konfiguriert '
      + `(${reason}). Die Signalisierung läuft NICHT über den App-Ursprung – `
      + 'dort liefert der App-Knoten die SPA aus (F6). Adresse setzen: '
      + 'SFU_SIGNALING_URL am Server (Antwort von /api/webrtc-config) oder '
      + 'VITE_SFU_URL beim Build.',
    );
    this.name = 'SfuSignalingNotConfiguredError';
  }
}

/** Absolute http(s)-Basis-URL normalisieren; `null` bei allem anderen. */
export function normalizeSfuUrl(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const trimmed = value.replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) return null;
  return trimmed;
}

/** socket.io-Pfad normalisieren (muss mit genau einem `/` beginnen). */
export function normalizeSfuPath(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value.startsWith('/') || value.startsWith('//')) return DEFAULT_SFU_SIGNALING_PATH;
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.length > 1 ? trimmed : DEFAULT_SFU_SIGNALING_PATH;
}

/** Liest die Build-Zeit-Basis-URL (`VITE_SFU_URL`) aus der Konfigurationsschicht. */
export function buildTimeSfuUrl(): string | null {
  return normalizeSfuUrl(SFU_SIGNALING_URL);
}

/**
 * Auflösung in der Reihenfolge Server → Build-Zeit (`VITE_SFU_URL`). Ein
 * leerer/ungültiger Serverwert fällt auf `VITE_SFU_URL` zurück, aber NIE auf den
 * App-Ursprung (genau der war der F6-Fehler).
 */
export function resolveSfuSignalingTarget(opts: {
  serverUrl?: unknown;
  viteUrl?: unknown;
  path?: unknown;
} = {}): SfuSignalingResolution {
  const path = normalizeSfuPath(opts.path ?? DEFAULT_SFU_SIGNALING_PATH);

  const serverUrl = normalizeSfuUrl(opts.serverUrl);
  if (serverUrl) return { target: { url: serverUrl, path, source: 'server' }, reason: '' };

  // Ohne ausdrücklichen Wert gilt der Build-Zeit-Wert aus der Config-Schicht.
  const viteRaw = opts.viteUrl !== undefined ? opts.viteUrl : buildTimeSfuUrl();
  const viteUrl = normalizeSfuUrl(viteRaw);
  if (viteUrl) return { target: { url: viteUrl, path, source: 'vite' }, reason: '' };

  const rawServer = String(opts.serverUrl ?? '').trim();
  const rawVite = String(viteRaw ?? '').trim();
  const reasons: string[] = [];
  if (rawServer) reasons.push('sfu.url aus /api/webrtc-config ist keine absolute http(s)-URL');
  else reasons.push('sfu.url fehlt in /api/webrtc-config (SFU_SIGNALING_URL am Server setzen)');
  if (rawVite) reasons.push('VITE_SFU_URL ist keine absolute http(s)-URL');
  else reasons.push('VITE_SFU_URL nicht gesetzt');
  return { target: null, reason: reasons.join('; ') };
}

/** Form der `/api/webrtc-config`-Antwort, die dieses Modul braucht. */
export interface SfuConfigFragment {
  sfu?: {
    url?: unknown;
    path?: unknown;
    ready?: unknown;
    reason?: unknown;
  } | null;
}

/**
 * Zwischenspeicher für die zuletzt vom Server gemeldete SFU-Adresse. Wer
 * `/api/webrtc-config` schon geladen hat (z. B. `refreshIceConfig`), muss sie
 * nicht zweimal holen; der Transport greift dann auf diesen Wert zu.
 */
let cachedServerSfu: SfuConfigFragment['sfu'] = null;

/** Merkt sich den Server-Block (null setzt den Zwischenspeicher zurück). */
export function cacheServerSfuSignaling(sfu: SfuConfigFragment['sfu'] | null): void {
  cachedServerSfu = sfu ?? null;
}

/** Der zwischengespeicherte Server-Block (null = keiner). */
export function cachedServerSfuSignaling(): SfuConfigFragment['sfu'] {
  return cachedServerSfu;
}

/**
 * Holt die SFU-Adresse vom Server (`GET /api/webrtc-config`). Fehler werden als
 * Begründung zurückgegeben, nicht geworfen: der Aufrufer entscheidet, ob er sie
 * meldet (die statische Konfiguration bleibt sonst aktiv).
 */
export async function fetchSfuSignalingTarget(
  fetchImpl: typeof fetch | undefined = typeof fetch !== 'undefined' ? fetch : undefined,
  options: { endpoint?: string; viteUrl?: string | null; useCache?: boolean } = {},
): Promise<SfuSignalingResolution> {
  const viteUrl = options.viteUrl !== undefined ? options.viteUrl : buildTimeSfuUrl();
  const useCache = options.useCache !== false;

  if (useCache && cachedServerSfu) {
    const cached = resolveSfuSignalingTarget({ serverUrl: cachedServerSfu.url, viteUrl, path: cachedServerSfu.path });
    if (cached.target) return cached;
  }

  if (!fetchImpl) {
    return resolveSfuSignalingTarget({ viteUrl });
  }
  const endpoint = options.endpoint ?? '/api/webrtc-config';
  try {
    const resp = await fetchImpl(endpoint, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as SfuConfigFragment;
    const sfu = data?.sfu ?? {};
    cacheServerSfuSignaling(sfu);
    const resolved = resolveSfuSignalingTarget({ serverUrl: sfu.url, viteUrl, path: sfu.path });
    if (resolved.target) return resolved;
    const serverReason = typeof sfu.reason === 'string' && sfu.reason.trim() ? `Server meldet: ${sfu.reason}` : '';
    return { target: null, reason: [serverReason, resolved.reason].filter(Boolean).join(' · ') };
  } catch (e) {
    const fallback = resolveSfuSignalingTarget({ viteUrl });
    if (fallback.target) return fallback;
    return { target: null, reason: `/api/webrtc-config nicht lesbar (${(e as Error).message}); ${fallback.reason}` };
  }
}

/**
 * Klartext für die Fehleranzeige: nennt das Ziel (falls vorhanden) und sonst den
 * Grund. So steht im UI, ob die Adresse fehlt oder die Verbindung scheitert.
 */
export function describeSfuSignaling(
  target: SfuSignalingTarget | null,
  reason = '',
): string {
  if (target) return `SFU ${target.url}${target.path} (${target.source})`;
  return `keine SFU-Adresse: ${reason || 'unbekannter Grund'}`;
}

/**
 * Mixed-Content-Prüfung: Eine HTTPS-Seite darf kein `http://`-Ziel öffnen – der
 * Browser blockiert die socket.io-Verbindung dann komplett (F6-Nachbarfehler:
 * "SFU-Adresse gesetzt, aber nichts verbindet"). Lokale/HTTP-Testaufbauten sind
 * davon ausgenommen (`pageProtocol` = 'http:').
 */
export function isMixedContentBlocked(pageProtocol: unknown, targetUrl: unknown): boolean {
  const page = String(pageProtocol ?? '').toLowerCase();
  const target = String(targetUrl ?? '').toLowerCase();
  return (page === 'https:' || page === 'wss:') && target.startsWith('http://');
}

/** Aktuelle Seiten-Protokoll (leer, wenn kein Browser/DOM vorhanden ist). */
export function currentPageProtocol(): string {
  try {
    if (typeof location !== 'undefined' && location?.protocol) return location.protocol;
  } catch {
    /* SSR/Test ohne DOM */
  }
  return '';
}
