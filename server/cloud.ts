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
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PRESET_SAMPLE_DATABASE, AudioSample } from '../src/data/samples';
import { MUSIC_LIBRARY, MusicTrack } from '../src/data/musicLibrary';
import { isValidSupabaseKey, supabasePublicKey, supabaseServerKey, supabaseServerKeyLabel } from '../src/config/supabaseKeys';
import { resolveR2Config, type R2Config } from './r2Config';
import {
  R2WriteError,
  r2ProblemHint,
  recordR2Write,
  runR2HealthCheck,
  toR2WriteError,
} from './r2Health';

const env = process.env;

/** Entfernt abschließende Slashes (für Public-URLs). */
export function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

const SAFE_OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9/._ -]{0,1023}$/;

function isSafeObjectKey(key: string): boolean {
  if (!key || key.length > 1024) return false;
  if (key.startsWith('/') || key.includes('\\') || key.includes('\0')) return false;
  if (key.split('/').some((segment) => segment === '..' || segment === '.')) return false;
  return SAFE_OBJECT_KEY.test(key);
}

/**
 * Liefert einen gültigen Supabase-Key oder `null`.
 * Die Formatprüfung liegt zentral in `src/config/supabaseKeys.ts`, damit
 * Server, Skripte und Client dieselbe Regel benutzen (Platzhalter, neue
 * `sb_*`-Formate, Legacy-JWT).
 */
function validSupabaseKey(key: string | undefined): string | null {
  const k = key?.trim() ?? '';
  return isValidSupabaseKey(k) ? k : null;
}

function supabaseUrl(): string | null {
  const url = (env.SB_URL ?? env.SUPABASE_URL)?.trim();
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
  // Zentrale Prioritätsordnung (Service-Role → JWT → Secret → Legacy-PAT):
  // ein abgelaufener Legacy-Key darf den gültigen Service-Role-Key nicht verdecken.
  const key = validSupabaseKey(supabaseServerKey(env));
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
  const key = validSupabaseKey(supabasePublicKey(env));
  if (!url || !key) return null;
  try {
    return createClient(url, key, { auth: { persistSession: false } });
  } catch {
    return null;
  }
}

/**
 * R2-Konfiguration aus EINER Herkunft (FIX F2).
 *
 * Vorher stand hier eine eigene Präzedenzliste (`CFS3_ACCESS_KEY` → …), die die
 * auf app-1 gesetzten `CFS3_ACCESS_KEY_ID`/`CFS3_SECRET_ACCESS_KEY` STILL
 * ignorierte und dann auf `CFR2_*` zurückfiel – genau der Weg in den
 * `SignatureDoesNotMatch`. Außerdem prüfte nur diese eine Stelle das
 * 32/64-Hex-Format; `server/cloudAutomation.ts` baute einen zweiten, abweichenden
 * Client und schwieg bei falschem Format. Jetzt lösen beide dieselbe Funktion auf.
 */
export function r2ConfigFromEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = env): R2Config {
  return resolveR2Config(source as Record<string, string | undefined>);
}

/** S3-Client zu einer bereits aufgelösten Konfiguration (Formatfehler ⇒ null). */
export function r2ClientFor(config: R2Config): S3Client | null {
  if (!config.configured) return null;
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // F2: Anzahl der SDK-internen Wiederholungen. Sie bleibt beim Standard (3),
    // damit sich am Upload-Verhalten nichts ändert; Tests und Ops setzen sie auf
    // 1, wenn die eigene Retry-Schicht (Autosave) die EINZIGE Wiederholung sein
    // soll – sonst multiplizieren sich SDK- und Routen-Wiederholungen.
    maxAttempts: Math.max(1, Math.floor(Number(env.R2_SDK_MAX_ATTEMPTS) || 3)),
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
      console.error('[cloud] Supabase-Schema nicht aktuell:', error.message);
      return {
        ok: false,
        error: 'supabase-schema-outdated',
      };
    }
    console.error('[cloud] pushSampleToCloud fehlgeschlagen:', error);
    return { ok: false, error: 'cloud-upload-failed' };
  }

  const tags = sample.tags ?? [];
  if (tags.length) {
    const tagRows = tags.map((tag) => ({ sample_id: sample.id, tag }));
    const { error: tagError } = await client
      .from('sample_tags')
      .upsert(tagRows, { onConflict: 'sample_id,tag' });
    if (tagError) {
      console.error('[cloud] sample_tags upsert fehlgeschlagen:', tagError);
      return { ok: false, error: 'cloud-tag-upload-failed' };
    }
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
  if (error) {
    console.error('[cloud] pushMusicTrackToCloud fehlgeschlagen:', error);
    return { ok: false, error: 'cloud-upload-failed' };
  }
  return { ok: true, id: track.id };
}

/**
 * Gesundheitscheck der Cloud-Anbindung.
 *
 * Supabase: kurzer Lese-Ping (service_role, sonst anon read-only).
 * R2: ECHTE Schreibprobe (PUT+DELETE eines kleinen Probeobjekts, mit Timeout),
 * siehe `server/r2Health.ts`.
 *
 * `options.force` (Route: `?probe=1`) misst R2 neu und ignoriert den TTL-Cache –
 * für die Betreiber-Diagnose direkt nach einer Credential-Korrektur.
 */
export async function cloudHealth(options: { force?: boolean } = {}) { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
  const sb = supabaseAdmin();

  let supabase = 'not-configured';
  if (sb) {
    try {
      // Ehrliches Label statt fest „service_role": nennt den tatsächlich
      // benutzten Schlüssel (service_role / sb_secret_ / legacy_pat).
      const label = supabaseServerKeyLabel(env);
      supabase = (await supabaseReadOk(sb)) ? `ok (${label})` : `error (${label})`;
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

  // R2: ECHTE Schreibprobe (PUT+DELETE eines kleinen Probeobjekts, mit Timeout).
  // Der frühere Check (`ListBuckets`) hat nur „Credentials vorhanden“ geprüft –
  // ein falsches Schlüsselpaar fiel erst beim ersten echten Schreibzugriff auf
  // und landete dann als Log-Flut im Betrieb. Siehe server/r2Health.ts.
  const r2 = await runR2HealthCheck({ force: options.force === true, env });

  return {
    supabase,
    r2: {
      // Kompatibilitätsfeld (bestehende Consumer: CloudStatusBadge, Smoke-Tests).
      status: r2.status,
      // F2: auswertbare Felder – Zustand, Ursache, Nachweis, Herkunft.
      state: r2.state,
      ok: r2.ok,
      problem: r2.problem,
      reason: r2.problem,
      message: r2.message,
      bucket: r2.bucket,
      endpoint: r2.endpointHost,
      probe: r2.method === 'none' ? null : { method: r2.method, key: r2.key, bucket: r2.bucket, attempts: r2.attempts },
      checkedAt: r2.checkedAt,
      durationMs: r2.durationMs,
      credentials: r2.credentials,
      hint: r2ProblemHint(r2.problem),
    },
  };
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
  const config = r2ConfigFromEnv();
  const r2 = r2ClientFor(config);
  const bucket = config.bucket;
  if (!r2) {
    // F2: Der Grund wird benannt (fehlend vs. Format vs. Bucket), statt alle
    // Fälle in eine Sammelmeldung zu werfen – sonst ist er im Betrieb nicht
    // von einem Signaturfehler unterscheidbar.
    const detail = config.problems.length ? config.problems.join(', ') : 'keine R2-Variablen gesetzt';
    throw new R2WriteError('not-configured', `R2 not configured (${detail}; check CFS3_ENDPOINT / CFS3_ACCESS_KEY / CFS3_SECRET_KEY / CFR2_ACCOUNT_ID)`);
  }
  if (!bucket) throw new R2WriteError('bucket-missing', 'CFS3_BUCKET missing');
  if (!isSafeObjectKey(objectKey)) throw new Error('invalid objectKey');

  try {
    await r2.send(new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }));
    recordR2Write('upload', { ok: true, attempts: 1 });
  } catch (error) {
    const writeError = toR2WriteError(error);
    recordR2Write('upload', { ok: false, problem: writeError.problem, message: writeError.message, attempts: 1 });
    throw writeError;
  }

  // Öffentliche Basis-URL bevorzugen (R2 > Settings > Public Access / r2.dev
  // oder eigene Domain). Ohne CFS3_PUBLIC_URL/CFR2_PUBLIC_URL fallback auf die
  // S3-Endpoint-URL (nur mit signierten Requests erreichbar).
  const publicBase = config.publicBaseUrl ? trimTrailingSlash(config.publicBaseUrl) : undefined;
  const encodedKey = objectKey.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return {
    key: objectKey,
    bucket,
    url: publicBase
      ? `${publicBase}/${encodedKey}`
      : `https://${bucket}.${config.accountId}.r2.cloudflarestorage.com/${encodedKey}`,
  };
}
