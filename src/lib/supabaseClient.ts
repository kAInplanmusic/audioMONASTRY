/**
 * supabaseClient – Browser-Supabase-Client (Options-Lieferung)
 * --------------------------------------------------------------
 * Baut einen Supabase-Client auf, der ausschließlich den PUBLISHABLE/ANON-Key
 * nutzt (RLS-geschützt). Wenn Cloud nicht konfiguriert ist (fehlende
 * VITE-Supabase-Werte), wird `null` geliefert, und die Aufrufer fallen auf die
 * eingebauten Presets zurück.
 *
 * Sicherheit: Niemals service_role-/secret-Keys hier (Client-seitig).
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_PUB, cloudEnabled } from './cloudConfig';

export interface CloudSampleRow {
  id: string;
  name: string;
  category: 'bass' | 'mids' | 'highs';
  type: string;
  url: string | null;
  description: string;
  tags: string[] | null;
  parameters: Record<string, unknown> | null;
}

export interface CloudMusicRow {
  id: string;
  name: string;
  artist: string;
  url: string;
  bpm: number | null;
}

let cached: SupabaseClient | null | undefined;

/** Liefert den (lazy) Supabase-Client oder `null`, wenn nicht verfügbar. */
export function getSupabaseClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  if (!cloudEnabled || !SUPABASE_URL || !SUPABASE_ANON_PUB) {
    cached = null;
    return null;
  }

  try {
    cached = createClient(SUPABASE_URL, SUPABASE_ANON_PUB, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    cached = null;
  }
  return cached;
}

/** Kurzes, typisiertes Ergebnis einer Datenabfrage. */
export interface CloudQueryResult<T> {
  ok: boolean;
  data: T[];
  error?: string;
}

/** `true`, falls die Cloud-Anbindung aktiv (und die Keys gesetzt) sind. */
export const isCloudAvailable = () => getSupabaseClient() !== null;

export async function fetchCloudSamples(): Promise<CloudQueryResult<CloudSampleRow>> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, data: [], error: 'supabase-not-configured' };
  try {
    const { data, error } = await client.from('samples').select('*').order('name');
    if (error) return { ok: false, data: [], error: error.message };
    return { ok: true, data: (data ?? []) as CloudSampleRow[] };
  } catch (e) {
    return { ok: false, data: [], error: (e as Error).message };
  }
}

export async function fetchCloudMusic(): Promise<CloudQueryResult<CloudMusicRow>> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, data: [], error: 'supabase-not-configured' };
  try {
    const { data, error } = await client.from('music_tracks').select('*').order('name');
    if (error) return { ok: false, data: [], error: error.message };
    return { ok: true, data: (data ?? []) as CloudMusicRow[] };
  } catch (e) {
    return { ok: false, data: [], error: (e as Error).message };
  }
}

// ============================================================================
// Schreib-/Sync-Pfad über die Server-API (service_role bleibt im Backend).
// Der Browser darf nie service_role-/secret-Keys sehen. Wenn der Server nicht
// erreichbar oder nicht konfiguriert ist, liefern diese Funktionen `ok:false`.
// ============================================================================

export interface CloudActionResult {
  ok: boolean;
  error?: string;
}

async function postJson<T = unknown>(path: string, body: unknown): Promise<T & { ok?: boolean; error?: string }> {
  const resp = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  return { ...data, ok: data.ok ?? resp.ok };
}

/** Sync der eingebauten Preset-Daten in die externe Supabase-Datenbank. */
export async function syncCloudDatabase(): Promise<CloudActionResult> {
  try {
    const data = await postJson<CloudActionResult>('/api/cloud/sync', {});
    return { ok: !!data.ok, error: data.error };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Ein einzelnes Sample in die externe Sample-Datenbank upserten. */
export async function pushSampleToCloud(
  sample: CloudSampleRow & { parameters?: Record<string, unknown> | null },
): Promise<CloudActionResult> {
  try {
    const data = await postJson<CloudActionResult>('/api/cloud/samples', sample);
    return { ok: !!data.ok, error: data.error };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Einen Musik-Track in die externe Musik-Datenbank upserten. */
export async function pushMusicToCloud(
  track: CloudMusicRow,
): Promise<CloudActionResult> {
  try {
    const data = await postJson<CloudActionResult>('/api/cloud/music', track);
    return { ok: !!data.ok, error: data.error };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Einen Audio-Blob (binär, ohne Base64-Overhead) in Cloudflare R2 hochladen. */
export async function uploadSampleBlobToCloud(
  key: string,
  blob: Blob,
  contentType = blob.type || 'audio/wav',
): Promise<CloudActionResult & { key?: string; url?: string }> {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const qs = `key=${encodeURIComponent(key)}&contentType=${encodeURIComponent(contentType)}`;
    const resp = await fetch(`/api/cloud/upload?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: arrayBuffer,
    });
    const data = (await resp.json().catch(() => ({}))) as CloudActionResult & { key?: string; url?: string };
    return { ok: data.ok ?? resp.ok, error: data.error, key: data.key, url: data.url };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
