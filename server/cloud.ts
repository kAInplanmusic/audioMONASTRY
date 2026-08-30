/**
 * server/cloud – Server-seitige Cloud-Anbindung (Supabase + Cloudflare R2)
 * -------------------------------------------------------------------------
 * - Supabase (service_role): Seed/Sync der eingebauten Preset-Daten in die
 *   externen Tabellen `samples`, `sample_tags`, `music_tracks` sowie
 *   Einzel-Upserts für neu erzeugte Samples/Tracks.
 * - Cloudflare R2 (S3-API): Upload von Audio-Blobs, die via
 *   `samples.url`/`music_tracks.url` referenziert werden.
 *
 * NUR Server-seitig verwenden (interne Keys im `.env`; niemals client-seitig).
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { PRESET_SAMPLE_DATABASE, AudioSample } from '../src/data/samples';
import { MUSIC_LIBRARY, MusicTrack } from '../src/data/musicLibrary';

const env = process.env;

/** Entfernt abschließende Slashes (für Public-URLs). */
export function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** Liefert einen gültigen Supabase-Key oder `null` (erkennt Platzhalter). */
function validSupabaseKey(key: string | undefined): string | null {
  const k = key?.trim() ?? '';
  if (!k || k.includes('.placeholder')) return null;

  // Neue Supabase-Key-Formate (sb_publishable_/sb_secret_) – langer Zufallsteil.
  if (k.startsWith('sb_publishable_') || k.startsWith('sb_secret_')) {
    return k.length >= 40 ? k : null;
  }

  // Legacy-JWT-Format (anon/service_role): 3 Segmente, signiert.
  if (k.startsWith('eyJ')) {
    const parts = k.split('.');
    return parts.length === 3 && k.length >= 80 ? k : null;
  }

  return k.length >= 32 ? k : null;
}

function supabaseUrl(): string | null {
  const url = env.SUPABASE_URL?.trim();
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function supabaseAdmin(): SupabaseClient | null {
  const url = supabaseUrl();
  const key = validSupabaseKey(env.SUPABASE_SERVICE_ROLE) ?? validSupabaseKey(env.SUPABASE_SERVICE_ROLE_JWT);
  if (!url || !key) return null;
  try {
    return createClient(url, key, { auth: { persistSession: false } });
  } catch {
    return null;
  }
}

/** Anon-/publishable-Client für Lese-Zugriffe (RLS-geschützt). */
function supabaseAnon(): SupabaseClient | null {
  const url = supabaseUrl();
  const key = validSupabaseKey(env.SUPABASE_ANON_PUB) ?? validSupabaseKey(env.SUPABASE_PUBLISHABLE);
  if (!url || !key) return null;
  try {
    return createClient(url, key, { auth: { persistSession: false } });
  } catch {
    return null;
  }
}

/** R2-Endpoint: explizit konfiguriert ODER Standard-Endpoint aus Account-ID. */
function r2Endpoint(accountId: string): string {
  // CFR2_URL / CFR2_ENDPOINT haben Vorrang (vom Betreiber bereitgestellter Endpoint).
  const raw = env.CFR2_URL?.trim() || env.CFR2_ENDPOINT?.trim() || env.CLOUDFLARE_API?.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' || u.protocol === 'http:') return raw;
    } catch {
      // ungültige URL -> Fallback auf Standard-Endpoint
    }
  }
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/** Liefert einen konfigurierten R2-S3-Client oder null, wenn Keys fehlen. */
function r2Client(): S3Client | null {
  // CFR2_URL-Hostname als Account-ID-Fallback (z. B. https://<account>.r2.cloudflarestorage.com).
  const fromUrl = (() => {
    const raw = env.CFR2_URL?.trim();
    if (!raw) return null;
    try {
      return new URL(raw).hostname.split('.')[0] ?? null;
    } catch {
      return null;
    }
  })();
  const accountId = env.CFR2_ACCOUNT_ID?.trim() || fromUrl || '';
  const accessKeyId = env.CFR2_ACCESS_KEY_ID?.trim() || env.CFR2_ACCESS_KEY?.trim();
  const secretAccessKey = env.CFR2_SECRET_ACCESS_KEY?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  // R2-Zugangsdaten sind hexadezimale Keys (Access 32, Secret 64 Zeichen).
  if (!/^[0-9a-f]{32}$/i.test(accessKeyId)) return null;
  if (!/^[0-9a-f]{64}$/i.test(secretAccessKey)) return null;

  return new S3Client({
    region: 'auto',
    endpoint: r2Endpoint(accountId),
    credentials: { accessKeyId, secretAccessKey },
  });
}

/** Kurzer Lese-Ping gegen die Supabase-Tabelle `samples`. */
async function supabaseReadOk(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.from('samples').select('id').limit(1);
  return !error;
}

/**
 * Sync – initialisiert/aktualisiert die eingebauten Preset-Daten in Supabase.
 * Idempotent (upsert). Liefert Anzahl synchronisierter Datensätze je Tabelle.
 */
export async function syncCloudDatabase() {
  const client = supabaseAdmin();
  const report: Record<string, number> = { samples: 0, sample_tags: 0, music: 0 };

  if (!client) {
    return { ok: false, error: 'supabase-service-role-not-configured', report };
  }

  // --- Samples (Metadaten + Parameter) ---
  const rows = PRESET_SAMPLE_DATABASE.map((s: AudioSample) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    type: s.type,
    url: s.url ?? null,
    description: s.description,
    tags: s.tags ?? [],
    parameters: s.parameters ?? {},
    source: 'seed',
  }));
  const tagsRows = PRESET_SAMPLE_DATABASE.flatMap((s: AudioSample) =>
    (s.tags ?? []).map((tag) => ({ sample_id: s.id, tag })),
  );

  if (rows.length) {
    const { error } = await client.from('samples').upsert(rows, { onConflict: 'id' });
    if (error) return { ok: false, error: error.message, report };
    report.samples = rows.length;
  }
  if (tagsRows.length) {
    const { error } = await client.from('sample_tags').upsert(tagsRows, { onConflict: 'sample_id,tag' });
    if (error) return { ok: false, error: error.message, report };
    report.sample_tags = tagsRows.length;
  }

  // --- Music Tracks ---
  const musicRows = MUSIC_LIBRARY.map((m: MusicTrack) => ({
    id: m.id,
    name: m.name,
    artist: m.artist,
    url: m.url,
    bpm: m.bpm ?? null,
  }));
  if (musicRows.length) {
    const { error } = await client.from('music_tracks').upsert(musicRows, { onConflict: 'id' });
    if (error) return { ok: false, error: error.message, report };
    report.music = musicRows.length;
  }

  return { ok: true, report };
}

/** Zusätzliche Metadaten für Uploads (Upload-Scan etc.). */
export interface SampleMetaExtras {
  kind?: string | null;
  artist?: string | null;
  style?: string | null;
  key?: string | null;
  bpm?: number | null;
  duration_seconds?: number | null;
  sample_rate?: number | null;
  lufs?: number | null;
  file_size?: number | null;
}

/** Upsert eines einzelnen Samples (inkl. Tag-Verweise) in die externe Datenbank. */
export async function pushSampleToCloud(sample: AudioSample, extras: SampleMetaExtras = {}) {
  const client = supabaseAdmin();
  if (!client) return { ok: false, error: 'supabase-service-role-not-configured' };

  const row = {
    id: sample.id,
    name: sample.name,
    category: sample.category,
    type: sample.type,
    url: sample.url ?? null,
    description: sample.description,
    tags: sample.tags ?? [],
    parameters: sample.parameters ?? {},
    source: sample.url ? 'generated' : 'seed',
    kind: extras.kind ?? 'sample',
    artist: extras.artist ?? null,
    style: extras.style ?? null,
    key: extras.key ?? null,
    bpm: extras.bpm ?? null,
    duration_seconds: extras.duration_seconds ?? null,
    sample_rate: extras.sample_rate ?? null,
    lufs: extras.lufs ?? null,
    file_size: extras.file_size ?? null,
  };
  const { error } = await client.from('samples').upsert(row, { onConflict: 'id' });
  if (error) {
    // Häufigster Fall: live DB hat noch das alte Schema (vor artist/style/...).
    if (/Could not find the .* column/i.test(error.message)) {
      return {
        ok: false,
        error: 'Supabase-Schema nicht aktuell – bitte `database/schema.sql` einmalig im Supabase SQL Editor ausführen. Details: ' + error.message,
      };
    }
    return { ok: false, error: error.message };
  }

  const tags = sample.tags ?? [];
  if (tags.length) {
    const tagRows = tags.map((tag) => ({ sample_id: sample.id, tag }));
    const { error: tagError } = await client
      .from('sample_tags')
      .upsert(tagRows, { onConflict: 'sample_id,tag' });
    if (tagError) return { ok: false, error: tagError.message };
  }

  return { ok: true, id: sample.id };
}

/** Upsert eines einzelnen Musik-Tracks in die externe Datenbank. */
export async function pushMusicTrackToCloud(
  track: MusicTrack,
  extras: { style?: string | null; key?: string | null; duration_seconds?: number | null; tags?: string[] | null } = {},
) {
  const client = supabaseAdmin();
  if (!client) return { ok: false, error: 'supabase-service-role-not-configured' };

  const row = {
    id: track.id,
    name: track.name,
    artist: track.artist,
    url: track.url,
    bpm: track.bpm ?? null,
    style: extras.style ?? null,
    key: extras.key ?? null,
    duration_seconds: extras.duration_seconds ?? null,
    tags: extras.tags ?? [],
  };
  const { error } = await client.from('music_tracks').upsert(row, { onConflict: 'id' });
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: track.id };
}

/** Gesundheitscheck der Cloud-Anbindung (Supabase ping + R2-Buckets). */
export async function cloudHealth() { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
  const sb = supabaseAdmin();
  const r2 = r2Client();

  let supabase = 'not-configured';
  if (sb) {
    try {
      supabase = (await supabaseReadOk(sb)) ? 'ok (service_role)' : 'error (service_role)';
    } catch (e) {
      supabase = `error: ${(e as Error).message}`;
    }
  }

  // Fallback: Lesender Anon-Zugriff (read-only) reicht für die App-Nutzung.
  if (supabase === 'not-configured' || supabase.startsWith('error')) {
    const anon = supabaseAnon();
    if (anon) {
      try {
        supabase = (await supabaseReadOk(anon)) ? 'ok (anon, read-only)' : 'error (anon)';
      } catch (e) {
        supabase = `error (anon): ${(e as Error).message}`;
      }
    }
  }

  let r2buckets: string[] | undefined;
  let r2status = 'not-configured';
  if (r2) {
    try {
      const res = await r2.send(new ListBucketsCommand({}));
      r2buckets = (res.Buckets ?? []).map((b) => b.Name ?? '');
      r2status = 'ok';
    } catch (e) {
      r2status = `error: ${(e as Error).message}`;
    }
  }

  return { supabase, r2: { status: r2status, buckets: r2buckets } };
}

/**
 * Lädt einen Audio-Blob in einen R2-Bucket. Der Rückgabewert enthält den
 * Objekt-Key, den Bucket sowie eine (best-effort) öffentliche S3-URL, die als
 * `samples.url` hinterlegt werden kann.
 */
export async function uploadSampleToR2(
  objectKey: string,
  body: Buffer | Uint8Array,
  contentType = 'audio/wav',
) {
  const r2 = r2Client();
  const bucket = env.CFR2_BUCKET?.trim();
  if (!r2) throw new Error('R2 not configured (check CFR2_ACCOUNT_ID / CFR2_ACCESS_KEY_ID / CFR2_SECRET_ACCESS_KEY)');
  if (!bucket) throw new Error('CFR2_BUCKET missing');

  await r2.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: body,
    ContentType: contentType,
  }));

  const accountId = env.CFR2_ACCOUNT_ID?.trim();
  // Öffentliche Basis-URL bevorzugen (R2 > Settings > Public Access / r2.dev
  // oder eigene Domain). Ohne CFR2_PUBLIC_URL fallback auf die S3-Endpoint-URL
  // (nur mit signierten Requests erreichbar).
  const publicBase = env.CFR2_PUBLIC_URL ? trimTrailingSlash(env.CFR2_PUBLIC_URL.trim()) : undefined;
  return {
    key: objectKey,
    bucket,
    url: publicBase
      ? `${publicBase}/${objectKey}`
      : `https://${bucket}.${accountId}.r2.cloudflarestorage.com/${objectKey}`,
  };
}
