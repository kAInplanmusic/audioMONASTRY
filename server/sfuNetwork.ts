/**
 * audioMONASTRY · SFU-Announced-IP zur LAUFZEIT ermitteln (F6)
 * =====================================================================
 * Befund F6 (2026-09-20): auf sfu-1 war `SFU_ANNOUNCED_IP` leer. Mediasoup
 * erzeugt dann ICE-Kandidaten ohne öffentliche Adresse – von aussen ist der
 * Medienpfad nicht erreichbar, und im Log stand nichts darüber. Der frühere
 * Portal-Pfad schrieb `hostname -I | awk '{print $1}'` – auf einem Knoten MIT
 * Hetzner-Privatnetz ist das die PRIVATE 10.x-Adresse, also eine Adresse, die
 * kein externer Browser je erreichen kann.
 *
 * Diese Datei ermittelt die öffentliche IPv4 deshalb zur Laufzeit, in dieser
 * Reihenfolge:
 *
 *   1. `SFU_ANNOUNCED_IP` aus der Umgebung (Vorrang – Betreiberentscheidung),
 *   2. Hetzner-Cloud-Metadata (`public-ipv4`, nur IM Cloud-Netz erreichbar),
 *   3. `https://api.ipify.org` als Aussenprobe.
 *
 * Eine private/reservierte Adresse wird NIE als Ankündigungsadresse akzeptiert:
 * sie ist von aussen nicht erreichbar und wäre ein stiller Fehlschlag. Ist keine
 * öffentliche IP ermittelbar, kommt `announcedIp: null` plus Grund zurück – der
 * Aufrufer meldet das laut, statt einen Scheinerfolg zu loggen.
 *
 * Bewusst ohne harte Abhängigkeit: `fetch` wird injiziert (Test ohne Netz).
 */

/** Quellen, aus denen die öffentliche IP stammen kann. */
export type AnnouncedIpSource = 'env' | 'hetzner-metadata' | 'ipify' | 'none';

export interface AnnouncedIpResolution {
  announcedIp: string | null;
  source: AnnouncedIpSource;
  /** Klartextgrund, wenn `announcedIp` null ist. */
  reason?: string;
  /** Was versucht wurde (für Log/Diagnose). */
  attempts: string[];
}

export const HETZNER_METADATA_URL = 'http://169.254.169.254/hetzner/v1/metadata';
export const IPIFY_URL = 'https://api.ipify.org';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** true für eine syntaktisch gültige öffentliche IPv4 (keine RFC1918/Loopback). */
export function isPublicIpv4(value: unknown): boolean {
  const m = IPV4.exec(String(value ?? '').trim());
  if (!m) return false;
  const octets = m.slice(1, 5).map((part) => Number(part));
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false; // Link-Local (Metadata-Endpunkt)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false; // Multicast/reserviert
  return true;
}

/** `public-ipv4` aus dem Hetzner-Metadata-Dokument (YAML-artige Key-Value-Liste). */
export function parseHetznerMetadataPublicIpv4(body: unknown): string | null {
  const text = String(body ?? '');
  const match = /^\s*public-ipv4:\s*(\S+)\s*$/m.exec(text);
  const candidate = match?.[1] ?? '';
  return isPublicIpv4(candidate) ? candidate : null;
}

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Überspringt die Metadata-Probe (z. B. ausserhalb der Hetzner-Cloud). */
  skipMetadata?: boolean;
  /** Überspringt die öffentliche Aussenprobe (Tests/Offline). */
  skipIpify?: boolean;
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; body: string; error?: string }> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, controller ? { signal: controller.signal } : {});
    if (!res?.ok) return { ok: false, body: '', error: `HTTP ${res?.status ?? '?'}` };
    return { ok: true, body: await res.text() };
  } catch (e) {
    return { ok: false, body: '', error: (e as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ermittelt die öffentliche IPv4 für Mediasoup-`announcedIp`. Wirft nie – ein
 * fehlender Wert ist ein Ergebnis (`announcedIp: null` + `reason`), damit der
 * Aufrufer den Betriebszustand melden kann statt zu crashen.
 */
export async function resolveSfuAnnouncedIp(
  env: Record<string, string | undefined> = process.env,
  opts: ResolveOptions = {},
): Promise<AnnouncedIpResolution> {
  const attempts: string[] = [];
  const explicit = String(env.SFU_ANNOUNCED_IP ?? '').trim();
  if (explicit) {
    if (isPublicIpv4(explicit)) return { announcedIp: explicit, source: 'env', attempts };
    return {
      announcedIp: null,
      source: 'none',
      reason: `SFU_ANNOUNCED_IP="${explicit.slice(0, 40)}" ist keine öffentliche IPv4 (privat/reserviert)`,
      attempts,
    };
  }

  const fetchImpl = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  if (!fetchImpl) {
    return { announcedIp: null, source: 'none', reason: 'kein fetch verfügbar und SFU_ANNOUNCED_IP nicht gesetzt', attempts };
  }
  const timeoutMs = opts.timeoutMs ?? 2000;

  if (!opts.skipMetadata) {
    const metaUrl = String(env.SFU_METADATA_URL ?? '').trim() || HETZNER_METADATA_URL;
    const meta = await fetchText(fetchImpl, metaUrl, timeoutMs);
    attempts.push(`hetzner-metadata ${meta.ok ? 'ok' : `fehlgeschlagen (${meta.error})`}`);
    if (meta.ok) {
      const ip = parseHetznerMetadataPublicIpv4(meta.body);
      if (ip) return { announcedIp: ip, source: 'hetzner-metadata', attempts };
    }
  }

  if (!opts.skipIpify) {
    const ipifyUrl = String(env.SFU_IPIFY_URL ?? '').trim() || IPIFY_URL;
    const ipify = await fetchText(fetchImpl, ipifyUrl, timeoutMs);
    attempts.push(`ipify ${ipify.ok ? 'ok' : `fehlgeschlagen (${ipify.error})`}`);
    if (ipify.ok) {
      const ip = String(ipify.body).trim();
      if (isPublicIpv4(ip)) return { announcedIp: ip, source: 'ipify', attempts };
    }
  }

  return {
    announcedIp: null,
    source: 'none',
    reason: 'keine öffentliche IPv4 ermittelbar (Metadata + Aussenprobe)',
    attempts,
  };
}
