/**
 * audioMONASTRY · Wohin darf ein Secret? (Host-Allowlist)
 * =======================================================
 * DA-2026-10-17-009: `voiceRuntimeInference` fiel bei fehlendem
 * `VOICE_AI_RUNTIME_TOKEN` auf `HF_TOKEN` zurueck und schickte dieses
 * Cloud-Credential als Bearer an JEDE in `VOICE_AI_RUNTIME_URL` eingetragene
 * URL - inklusive Tippfehler, Proxy oder Fremd-Pod.
 *
 * Regel hier: `HF_TOKEN` verlaesst den Prozess nur, wenn der Ziel-Host
 *   (a) exakt dem Host einer konfigurierten eigenen Runtime entspricht
 *       (`VOICE_AI_RUNTIME_URL`, `SONG_AI_ACE_STEP_URL`, `SONG_AI_DIFF_RHYTHM_URL`)
 *   (b) oder ausdruecklich in `AI_SECRET_HOSTS` steht (Komma, `*.example.com`).
 *
 * HF-Endpunkte sind damit NICHT hart verdrahtet: der statische Waechter
 * `tests/aiLocalOnly.test.ts` (RT-AUDIT-P1-014) verbietet Cloud-AI-Hosts im
 * Produktcode. Wer einen HF-Endpunkt uebergangsweise als Runtime nutzt, traegt
 * ihn in `AI_SECRET_HOSTS` ein - sichtbar in der Konfiguration, nicht im Code.
 *
 * Der eigene `VOICE_AI_RUNTIME_TOKEN` ist davon unberuehrt: er gehoert zur
 * Runtime und geht (wie bisher) an deren Host.
 */
import { hostMatchesPattern, isPrivateOrLocalHost } from './outboundUrl';

/** Env-Namen, deren Hosts als "eigene Runtime" gelten. */
const RUNTIME_URL_ENVS = ['VOICE_AI_RUNTIME_URL', 'SONG_AI_ACE_STEP_URL', 'SONG_AI_DIFF_RHYTHM_URL'];

/** Explizite Allowlist fuer Secrets (`AI_SECRET_HOSTS`). */
const SECRET_HOSTS_ENV = 'AI_SECRET_HOSTS';

function env(name: string): string {
  if (typeof process === 'undefined' || !process.env) return '';
  return String(process.env[name] ?? '').trim();
}

/** Host einer Env-URL (leer, wenn nicht gesetzt/parsebar). */
function hostOfEnvUrl(name: string): string {
  const value = env(name);
  if (!value) return '';
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Alle Hosts, an die ein HF-Token hoechstens gehen darf. */
export function hfTokenAllowedHosts(): string[] {
  const hosts = new Set<string>();
  for (const name of RUNTIME_URL_ENVS) {
    const host = hostOfEnvUrl(name);
    if (host) hosts.add(host);
  }
  for (const entry of env(SECRET_HOSTS_ENV).split(',')) {
    const clean = entry.trim().toLowerCase();
    if (clean) hosts.add(clean);
  }
  return [...hosts];
}

/**
 * Darf ein HF-Token an diese URL gehen?
 * Fail-closed: unparsebare URL, private Ziele und fremde Hosts -> false.
 */
export function maySendHfToken(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || isPrivateOrLocalHost(host)) return false;
  return hfTokenAllowedHosts().some((pattern) => hostMatchesPattern(host, pattern));
}

let warnedHosts = new Set<string>();

/** Testhilfe: Warn-Zustand zuruecksetzen. */
export function resetHfTokenWarnings(): void {
  warnedHosts = new Set<string>();
}

export interface RuntimeTokenInput {
  /** Token der eigenen Runtime (`VOICE_AI_RUNTIME_TOKEN`). */
  runtimeToken?: string;
  /** Cloud-Credential (`HF_TOKEN`) - nur als dokumentierter Uebergang. */
  hfToken?: string;
}

/**
 * Waehlt den Bearer-Token fuer einen Runtime-Aufruf.
 *
 * Reihenfolge: eigener Runtime-Token -> HF_TOKEN (nur bei erlaubtem Host) -> ''.
 * Der Fallback wird pro Host EINMAL laut geloggt (kein stiller Secret-Versand).
 */
export function resolveRuntimeToken(url: string, input: RuntimeTokenInput = {}): string {
  const runtimeToken = String(input.runtimeToken ?? '').trim();
  if (runtimeToken) return runtimeToken;
  const hfToken = String(input.hfToken ?? '').trim();
  if (!hfToken) return '';

  let host = 'unbekannt';
  try {
    host = new URL(url).hostname;
  } catch {
    // Host bleibt "unbekannt"
  }

  if (!maySendHfToken(url)) {
    if (!warnedHosts.has(host)) {
      warnedHosts.add(host);
      console.warn(
        `[ai] HF_TOKEN wird NICHT an ${host} gesendet (DA-2026-10-17-009: Host nicht auf der Allowlist) – ` +
        'VOICE_AI_RUNTIME_TOKEN setzen.',
      );
    }
    return '';
  }

  if (!warnedHosts.has(host)) {
    warnedHosts.add(host);
    console.warn(
      `[ai] HF_TOKEN als Uebergangs-Token fuer ${host} (DA-2026-10-17-009) – VOICE_AI_RUNTIME_TOKEN setzen.`,
    );
  }
  return hfToken;
}
