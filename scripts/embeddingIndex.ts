/**
 * audioMONASTRY · Reine Helfer des Audio-Embedding-Batch-Indexers (DB-P1-004)
 * ==========================================================================
 * Der Indexer (`index-sample-audio-embeddings.ts`) selbst ist ein Skript mit
 * Netzwerk-/DB-Zugriff; seine Entscheidungen sind hier herausgezogen, damit sie
 * ohne Vast.ai/Supabase testbar sind.
 *
 * Native Vast runtime configuration matches podRouting: HTTPS VAST_POD_URL_EARS
 * and AI_POD_TOKEN (minimum 32 characters). Control-plane API keys/endpoint IDs
 * cannot authenticate an inference request. Supabase resolution stays unchanged.
 */
import { supabaseServerKey, supabaseUrl } from '../src/config/supabaseKeys';

export const CLAP_MODEL = 'clap-music';
export const CLAP_DIMS = 512;

type Env = Record<string, string | undefined>;

export interface IndexerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  podUrl: string;
  podToken: string;
}

export interface IndexerConfigResult {
  /** `null`, wenn etwas fehlt - dann nennt `missing` die fehlenden Variablen. */
  config: IndexerConfig | null;
  missing: string[];
}

function readEnv(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

/** Same origin-only TLS contract as podRouting.podBaseUrl (no credentials/path/query). */
export function resolveEarsPodUrl(env: Env = process.env): string {
  try {
    const url = new URL(readEnv(env, 'VAST_POD_URL_EARS').replace(/\/+$/, ''));
    return url.protocol === 'https:' && !url.username && !url.password && !url.search
      && !url.hash && url.pathname === '/' ? url.origin : '';
  } catch { return ''; }
}

export function resolvePodToken(env: Env = process.env): string {
  const token = readEnv(env, 'AI_POD_TOKEN');
  return token.length >= 32 ? token : '';
}

/** Alle Zugangsdaten fuer den Indexer; `missing` nennt die fehlenden Namen. */
export function resolveIndexerConfig(env: Env = process.env): IndexerConfigResult {
  const url = supabaseUrl(env);
  const key = supabaseServerKey(env);
  const podUrl = resolveEarsPodUrl(env);
  const podToken = resolvePodToken(env);
  const missing: string[] = [];
  if (!url) missing.push('SB_URL');
  if (!key) missing.push('SB_SERVICE_ROLE');
  if (!podUrl) missing.push('VAST_POD_URL_EARS (HTTPS origin)');
  if (!podToken) missing.push('AI_POD_TOKEN (minimum 32 characters)');
  if (missing.length) return { config: null, missing };
  return { config: { supabaseUrl: url, supabaseKey: key, podUrl, podToken }, missing: [] };
}

/**
 * Teilt die Bibliothek in indexierbare und uebersprungene Eintraege.
 * Ohne `parameters` kann `renderPresetWav` nichts rendern - solche Eintraege
 * werden gezaehlt uebersprungen, nicht stillschweigend verschluckt.
 */
export function pickIndexableSamples<T extends { parameters?: unknown }>(
  samples: readonly T[],
): { usable: T[]; skipped: T[] } {
  const usable: T[] = [];
  const skipped: T[] = [];
  for (const sample of samples) {
    (sample?.parameters && typeof sample.parameters === 'object' ? usable : skipped).push(sample);
  }
  return { usable, skipped };
}

/**
 * `INDEX_LIMIT` fuer Teillaeufe. 0/leer/ungueltig heisst "alles" (der Indexer
 * laeuft sonst versehentlich nur teilweise und meldet trotzdem Erfolg).
 */
export function parseIndexLimit(raw: string | undefined): number {
  const value = Number(raw ?? '');
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
