/**
 * supabaseClient – Bibliotheks-Zugriff des Browsers
 * -------------------------------------------------
 * DB-2026-11-06-001: Der Browser liest die Bibliothek NICHT mehr direkt aus
 * Supabase. Vorher holte er `samples`/`music_tracks` per PostgREST mit dem
 * anon-/publishable-Key, der im oeffentlichen Bundle liegt - und die
 * RLS-Policies dieser Tabellen lauteten `using (true)`. Live gemessen am
 * 2026-11-06: 995 Sample-Zeilen und 434 Musik-Zeilen weltweit abrufbar, inkl.
 * artist/url/lufs/file_size/parameters.
 *
 * Jetzt liest der Server: `GET /api/library` (Studio-Token/Cookie, service_role
 * bleibt serverseitig) liefert genau die Felder, die die UI braucht. Der
 * anon-Key wird fuer das Lesen nicht mehr gebraucht; die Migration
 * 016_library_rls_private.sql laesst anon nur noch Zeilen mit is_public=true
 * sehen (Bestand: keine).
 *
 * Schreib-/Sync-Pfade laufen weiterhin ueber die Server-API (unten) - der
 * Browser sieht nie einen service_role-/secret-Key.
 */
import { cloudEnabled } from './cloudConfig';

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

/** Antwortform von `GET /api/library` (server/routes/mediaRoutes.ts). */
interface LibraryResponse {
  ok?: boolean;
  samples?: CloudSampleRow[];
  music?: CloudMusicRow[];
  error?: string;
}

/** Die Bibliothek aendert sich selten; 15 s Cache spart den zweiten Abruf. */
const LIBRARY_CACHE_MS = 15_000;

let libraryCache: { at: number; payload: Promise<LibraryResponse> } | null = null;

/**
 * Ein Abruf fuer beide Listen: `/api/library` liefert `samples` und `music`
 * zusammen. SampleContext und LibraryTerminal fragen getrennt, deshalb teilen
 * sie sich hier denselben Promise statt zweimal 995 Zeilen zu ziehen.
 */
function loadLibrary(): Promise<LibraryResponse> {
  const now = Date.now();
  if (libraryCache && now - libraryCache.at < LIBRARY_CACHE_MS) return libraryCache.payload;

  const payload = fetch('/api/library', {
    method: 'GET',
    // Das Studio-Cookie ist HttpOnly und same-origin - `same-origin` schickt es
    // mit. Ohne Token antwortet der Server 401 (fail-closed), nicht mit Daten.
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    cache: 'no-store',
  })
    .then(async (resp) => {
      const body = (await resp.json().catch(() => ({}))) as LibraryResponse;
      if (!resp.ok) return { ok: false, error: body.error ?? `http-${resp.status}` } satisfies LibraryResponse;
      return body;
    })
    .catch((e: Error) => ({ ok: false, error: e.message }) satisfies LibraryResponse);

  libraryCache = { at: now, payload };
  return payload;
}

/** Kurzes, typisiertes Ergebnis einer Datenabfrage. */
export interface CloudQueryResult<T> {
  ok: boolean;
  data: T[];
  error?: string;
}

/**
 * `true`, sobald ueberhaupt eine Bibliothek abfragbar sein kann.
 *
 * Bewusst NICHT mehr an die VITE-Supabase-Werte gebunden: die Bibliothek kommt
 * vom eigenen Server (`/api/library`). Ist Supabase dort nicht konfiguriert,
 * antwortet die Route 503, und die Aufrufer fallen auf die Presets zurueck -
 * das ist die ehrliche Auskunft. Ein clientseitiges Gate auf den anon-Key
 * wuerde die Bibliothek genau dann abschalten, wenn der (fuer das Lesen nicht
 * mehr gebrauchte) Key aus dem Bundle entfernt wird.
 */
export const isCloudAvailable = (): boolean => true;

/**
 * Nur Diagnose: sind im Build ueberhaupt Supabase-Werte gesetzt? Das Lesen
 * haengt nicht mehr daran (siehe isCloudAvailable).
 */
export const cloudValuesPresent = cloudEnabled;

export async function fetchCloudSamples(): Promise<CloudQueryResult<CloudSampleRow>> {
  const res = await loadLibrary();
  if (res.ok === false) return { ok: false, data: [], error: res.error ?? 'library-unavailable' };
  return { ok: true, data: res.samples ?? [] };
}

export async function fetchCloudMusic(): Promise<CloudQueryResult<CloudMusicRow>> {
  const res = await loadLibrary();
  if (res.ok === false) return { ok: false, data: [], error: res.error ?? 'library-unavailable' };
  return { ok: true, data: res.music ?? [] };
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
