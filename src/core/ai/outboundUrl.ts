/**
 * audioMONASTRY · Ausgehende URLs (SSRF-Haertung)
 * ===============================================
 * DA-2026-10-17-011: Das Backend hat Audio-/Bild-URLs ungeprueft geladen, sobald
 * sie mit `http` begannen. Damit war jeder Wrapper (ACE-Step, DiffRhythm) und
 * jeder Client in der Lage, den Server auf interne Ziele zu schicken:
 * `http://169.254.169.254/latest/meta-data/`, `http://127.0.0.1:5432`, o. ae.
 *
 * Diese Datei ist die EINZIGE Stelle, an der solche URLs geprueft werden:
 *   - nur `http:`/`https:` (kein `file:`, `data:`, `gopher:` …)
 *   - keine Zugangsdaten in der URL
 *   - keine privaten/loopback/link-local/CGNAT/Multicast-/Dokumentations-IPs
 *     (IPv4, IPv6 und IPv4-gemappte IPv6)
 *   - Host-Allowlist: der Host des konfigurierten Backends plus
 *     `AUDIO_FETCH_ALLOWED_HOSTS` (Komma, `*.example.com` erlaubt)
 *   - Redirects werden NICHT automatisch verfolgt: jede Location wird erneut
 *     gegen dieselben Regeln geprueft (max. 3 Hops)
 *   - Groessenlimit beim Lesen (Default 64 MiB), damit ein Endlosstream den
 *     Prozess nicht in den Heap zieht
 */
/** Minimale Response-Sicht (globales fetch und Test-Doubles). */
interface BodyResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body?: unknown;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Fehlercodes sind stabil und werden im Log/Test benutzt (nie an den Client). */
export type OutboundUrlCode =
  | 'INVALID_URL'
  | 'BLOCKED_PROTOCOL'
  | 'CREDENTIALS_IN_URL'
  | 'BLOCKED_HOST'
  | 'HOST_NOT_ALLOWED'
  | 'REDIRECT_LIMIT'
  | 'TOO_LARGE'
  | 'UPSTREAM_HTTP'
  | 'FETCH_FAILED';

export class OutboundUrlError extends Error {
  constructor(
    readonly code: OutboundUrlCode,
    message: string,
    /** HTTP-Status, falls der Fehler von einer Antwort stammt. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OutboundUrlError';
  }
}

/** Standard-Obergrenze fuer einen Audio-/Bild-Download (DA-011, 64 MiB). */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** Standard-Anzahl erlaubter Redirect-Hops. */
export const DEFAULT_MAX_REDIRECTS = 3;

/** Private/reservierte IPv4-Bereiche als [Basis, Praefixlaenge]. */
const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "dieses Netz"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // Loopback
  ['169.254.0.0', 16], // Link-Local (Cloud-Metadata!)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF-Protokollzuweisungen
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // Benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // Multicast
  ['240.0.0.0', 4], // reserviert (inkl. 255.255.255.255)
];

/** Hostnamen, die nie ein legitimes Audio-/Bild-Backend sind. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isFinite(octet) || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function isPrivateIpv4(host: string): boolean {
  const value = ipv4ToInt(host);
  if (value === null) return false;
  for (const [base, bits] of PRIVATE_IPV4_RANGES) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return true;
  }
  return false;
}

/** `::ffff:7f00:1` -> `127.0.0.1` (IPv4-gemappte Adresse in Hex-Schreibweise). */
function mappedIpv4FromHex(tail: string): string | null {
  const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!match) return null;
  const hi = parseInt(match[1], 16);
  const lo = parseInt(match[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIpv6(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // IPv4-gemappt: ::ffff:127.0.0.1 oder ::ffff:7f00:1
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const tail = mapped[1];
    if (tail.includes('.')) return isPrivateIpv4(tail);
    const asV4 = mappedIpv4FromHex(tail);
    if (asV4) return isPrivateIpv4(asV4);
    return true; // unparsebar -> fail-closed
  }
  // Unique-Local fc00::/7 und Link-Local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  // Multicast ff00::/8
  if (/^ff[0-9a-f]{2}:/.test(host)) return true;
  // Dokumentation 2001:db8::/32
  if (/^2001:0?db8:/.test(host)) return true;
  return false;
}

/**
 * Ist der Host privat, loopback, link-local oder reserviert?
 * Deckt IPv4-Literale, IPv6 (inkl. gemappt) und lokale Namen ab.
 */
export function isPrivateOrLocalHost(rawHost: string): boolean {
  const host = String(rawHost ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return true;
  }
  if (isPrivateIpv4(host)) return true;
  if (isPrivateIpv6(host)) return true;
  return false;
}

/** Host-Muster (`*.example.com` erlaubt Wildcards nur fuer eine Ebene). */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const cleanHost = host.toLowerCase();
  const cleanPattern = pattern.trim().toLowerCase().replace(/\.$/, '');
  if (!cleanPattern) return false;
  if (cleanPattern === '*') return true;
  if (cleanPattern.startsWith('*.')) {
    // Eine Ebene: `*.example.com` matcht `pod.example.com`, aber NICHT
    // `a.pod.example.com` (sonst waere die Allowlist breiter als geschrieben).
    const suffix = cleanPattern.slice(2);
    if (!cleanHost.endsWith(`.${suffix}`)) return false;
    const label = cleanHost.slice(0, cleanHost.length - suffix.length - 1);
    return label.length > 0 && !label.includes('.');
  }
  return cleanHost === cleanPattern;
}

/** Hosts aus `AUDIO_FETCH_ALLOWED_HOSTS` (Komma-getrennt). */
export function configuredAudioHosts(): string[] {
  if (typeof process === 'undefined' || !process.env) return [];
  return String(process.env.AUDIO_FETCH_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Allowlist fuer Audio-/Bild-Downloads: der Host des Backends, von dem die URL
 * stammt (der Wrapper liefert relative Pfade gegen seine eigene Origin) plus
 * die ausdruecklich konfigurierten Hosts.
 */
export function audioHostAllowlist(baseUrl: string, extra: readonly string[] = []): string[] {
  const hosts = new Set<string>();
  try {
    hosts.add(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    // keine gueltige Basis: dann gilt nur die explizite Liste
  }
  for (const entry of [...configuredAudioHosts(), ...extra]) {
    const clean = entry.trim().toLowerCase();
    if (clean) hosts.add(clean);
  }
  return [...hosts];
}

export interface ResolveSafeUrlOptions {
  /** Origin des Backends; relative Pfade werden dagegen aufgeloest. */
  baseUrl: string;
  /** Zusaetzliche erlaubte Hosts/Muster. */
  allowedHosts?: readonly string[];
  /** max. Laenge der Roh-URL. */
  maxLength?: number;
}

/**
 * Prueft eine (ggf. relative) Backend-URL und liefert ein absolutes URL-Objekt.
 * Wirft `OutboundUrlError` bei jedem Verstoss.
 */
export function resolveSafeOutboundUrl(raw: unknown, options: ResolveSafeUrlOptions): URL {
  const text = String(raw ?? '').trim();
  if (!text) throw new OutboundUrlError('INVALID_URL', 'URL fehlt');
  if (text.length > (options.maxLength ?? 4000)) {
    throw new OutboundUrlError('INVALID_URL', 'URL zu lang');
  }
  // Steuerzeichen/Whitespace in der URL sind immer ein Fehler.
  if (/[\u0000-\u0020\u007f]/.test(text)) {
    throw new OutboundUrlError('INVALID_URL', 'URL enthaelt Steuerzeichen');
  }

  let url: URL;
  try {
    url = new URL(text, options.baseUrl);
  } catch {
    throw new OutboundUrlError('INVALID_URL', 'URL nicht parsebar');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundUrlError('BLOCKED_PROTOCOL', `Protokoll ${url.protocol} nicht erlaubt`);
  }
  if (url.username || url.password) {
    throw new OutboundUrlError('CREDENTIALS_IN_URL', 'URL enthaelt Zugangsdaten');
  }
  if (!url.hostname) throw new OutboundUrlError('INVALID_URL', 'URL ohne Host');
  if (isPrivateOrLocalHost(url.hostname)) {
    throw new OutboundUrlError('BLOCKED_HOST', 'privates/loopback Ziel blockiert');
  }

  const allowed = options.allowedHosts ?? [];
  if (allowed.length > 0 && !allowed.some((pattern) => hostMatchesPattern(url.hostname, pattern))) {
    throw new OutboundUrlError('HOST_NOT_ALLOWED', 'Host steht nicht auf der Allowlist');
  }
  return url;
}

/** Body mit Obergrenze lesen (Content-Length + Streaming-Limit). */
async function readBodyCapped(resp: BodyResponse, maxBytes: number): Promise<Buffer> {
  const declared = Number(resp.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OutboundUrlError('TOO_LARGE', `Antwort groesser als ${maxBytes} Bytes`);
  }
  const stream = resp.body as ReadableStream<Uint8Array> | null;
  if (!stream || typeof stream.getReader !== 'function') {
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > maxBytes) throw new OutboundUrlError('TOO_LARGE', `Antwort groesser als ${maxBytes} Bytes`);
    return buffer;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new OutboundUrlError('TOO_LARGE', `Antwort groesser als ${maxBytes} Bytes`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export interface FetchOutboundOptions extends ResolveSafeUrlOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Laedt eine Backend-URL mit vollstaendiger SSRF-Pruefung und Groessenlimit.
 * Redirects werden manuell verfolgt und JEDER Hop neu geprueft - ein 302 nach
 * `http://127.0.0.1` ist damit wirkungslos.
 */
export async function fetchOutboundBuffer(raw: unknown, options: FetchOutboundOptions): Promise<Buffer> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? 60_000;
  let current = resolveSafeOutboundUrl(raw, options);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let resp: BodyResponse;
    try {
      resp = await doFetch(current.toString(), {
        method: 'GET',
        // DA-2026-10-17-011: kein automatisches Folgen - sonst waere die
        // Allowlist nach dem ersten Redirect umgangen.
        redirect: 'manual',
        headers: options.headers,
        signal: AbortSignal.timeout(timeoutMs),
      }) as unknown as BodyResponse;
    } catch (error) {
      throw new OutboundUrlError('FETCH_FAILED', (error as Error)?.name === 'TimeoutError' ? 'Zeitlimit' : 'Netzwerkfehler');
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) throw new OutboundUrlError('UPSTREAM_HTTP', `HTTP ${resp.status} ohne Location`, resp.status);
      if (hop === maxRedirects) throw new OutboundUrlError('REDIRECT_LIMIT', 'zu viele Redirects');
      current = resolveSafeOutboundUrl(location, { ...options, baseUrl: current.toString() });
      continue;
    }
    if (!resp.ok) {
      throw new OutboundUrlError('UPSTREAM_HTTP', `HTTP ${resp.status}`, resp.status);
    }
    return readBodyCapped(resp, maxBytes);
  }
  throw new OutboundUrlError('REDIRECT_LIMIT', 'zu viele Redirects');
}
