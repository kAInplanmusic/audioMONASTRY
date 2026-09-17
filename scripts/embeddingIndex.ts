/**
 * audioMONASTRY · Reine Helfer des Audio-Embedding-Batch-Indexers (DB-P1-004)
 * ==========================================================================
 * Der Indexer (`index-sample-audio-embeddings.ts`) selbst ist ein Skript mit
 * Netzwerk-/DB-Zugriff; seine Entscheidungen sind hier herausgezogen, damit sie
 * ohne RunPod/Supabase testbar sind.
 *
 * Anlass (live gemessen 2026-09-17): das Skript verlangte dokumentiert
 * `RUNPOD_ENDPOINT_ID_EARS` + `RUNPOD_API_KEY`, die `.env` fuehrt die Werte aber
 * unter `RP_ENDPOINT_ID_EARS` + `RP_API_KEY` - der dokumentierte Aufruf brach
 * sofort mit "RUNPOD_ENDPOINT_ID_EARS / RUNPOD_API_KEY fehlen in der .env" ab,
 * obwohl beide gesetzt waren. Der Indexer lief damit nur mit von Hand gesetzten
 * Variablen, also nicht reproduzierbar.
 *
 * Deshalb hier dieselbe Aufloesungsordnung wie im restlichen Code:
 *   * Endpoint-ID: `GPU_ROLES.ears.endpointIdEnv` (Single Source of Truth in
 *     `src/core/ai/orchestrator/endpointRegistry.ts`) plus die legacy
 *     `RUNPOD_ENDPOINT_ID_EARS`-Schreibweise und der gemeinsame Fallback
 *     `RP_ENDPOINT_ID` / `RUNPOD_ENDPOINT_ID`.
 *   * API-Key: `RP_AGENT_KEY` -> `RP_API_KEY` -> `RUNPOD_API_KEY` (dieselbe
 *     Reihenfolge wie `runpodProvider.ts`/`fleetWake.ts`).
 *   * Supabase wie ueberall: `supabaseUrl()` (SB_URL vor SUPABASE_URL) und
 *     `supabaseServerKey()`.
 */
import { GPU_ROLES } from '../src/core/ai/orchestrator/endpointRegistry';
import { supabaseServerKey, supabaseUrl } from '../src/config/supabaseKeys';

export const CLAP_MODEL = 'clap-music';
export const CLAP_DIMS = 512;

/** Reihenfolge der RunPod-API-Keys - Spiegel von `runpodProvider.ts`. */
export const RUNPOD_API_KEY_ORDER = ['RP_AGENT_KEY', 'RP_API_KEY', 'RUNPOD_API_KEY'] as const;

type Env = Record<string, string | undefined>;

export interface IndexerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  endpointId: string;
  apiKey: string;
}

export interface IndexerConfigResult {
  /** `null`, wenn etwas fehlt - dann nennt `missing` die fehlenden Variablen. */
  config: IndexerConfig | null;
  missing: string[];
}

function readEnv(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

/** Endpoint-ID der ears-Rolle, legacy-Schreibweisen und Fallback eingeschlossen. */
export function resolveEarsEndpointId(env: Env = process.env): string {
  const ownEnv = GPU_ROLES.ears.endpointIdEnv; // 'RP_ENDPOINT_ID_EARS'
  const legacyOwnEnv = ownEnv.replace(/^RP_/, 'RUNPOD_');
  return (
    readEnv(env, ownEnv) ||
    readEnv(env, legacyOwnEnv) ||
    readEnv(env, 'RP_ENDPOINT_ID') ||
    readEnv(env, 'RUNPOD_ENDPOINT_ID')
  );
}

/** RunPod-API-Key in der kanonischen Reihenfolge. */
export function resolveRunpodApiKey(env: Env = process.env): string {
  for (const name of RUNPOD_API_KEY_ORDER) {
    const value = readEnv(env, name);
    if (value) return value;
  }
  return '';
}

/** Alle Zugangsdaten fuer den Indexer; `missing` nennt die fehlenden Namen. */
export function resolveIndexerConfig(env: Env = process.env): IndexerConfigResult {
  const url = supabaseUrl(env);
  const key = supabaseServerKey(env);
  const endpointId = resolveEarsEndpointId(env);
  const apiKey = resolveRunpodApiKey(env);
  const missing: string[] = [];
  if (!url) missing.push('SB_URL');
  if (!key) missing.push('SB_SERVICE_ROLE');
  if (!endpointId) missing.push(`${GPU_ROLES.ears.endpointIdEnv} (oder RUNPOD_ENDPOINT_ID_EARS / RP_ENDPOINT_ID)`);
  if (!apiKey) missing.push(`${RUNPOD_API_KEY_ORDER.join(' / ')}`);
  if (missing.length) return { config: null, missing };
  return { config: { supabaseUrl: url, supabaseKey: key, endpointId, apiKey }, missing: [] };
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
