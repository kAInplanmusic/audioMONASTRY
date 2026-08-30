/**
 * server/cloudAutomation – R2 <-> Supabase Automation
 * ===================================================
 * - Bestehende R2-Audio-Objekte in Supabase einpflegen (Kategorien/Tags)
 * - Neue Audio-Objekte automatisch analysieren, ablegen und verschlagworten
 */
import { S3Client, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const env = process.env;

const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aiff?|webm|opus)$/i;

export interface AudioMetadata {
  kind: 'sample' | 'music';
  name: string;
  artist?: string;
  category: string;
  type: string;
  style?: string;
  tags: string[];
  url: string;
  fileSize?: number;
}

function r2Client(): S3Client | null {
  const accountId = env.CFR2_ACCOUNT_ID?.trim();
  const accessKeyId = env.CFR2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.CFR2_SECRET_ACCESS_KEY?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function supabaseAdmin(): SupabaseClient | null {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE?.trim() || env.SUPABASE_SERVICE_ROLE_JWT?.trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

function r2PublicUrl(key: string): string {
  const bucket = env.CFR2_BUCKET?.trim() || 'audiomonastrysamples';
  const accountId = env.CFR2_ACCOUNT_ID?.trim() || '';
  const publicBase = env.CFR2_PUBLIC_URL ? trimTrailingSlash(env.CFR2_PUBLIC_URL.trim()) : '';
  if (publicBase) return `${publicBase}/${key}`;
  return `https://${bucket}.${accountId}.r2.cloudflarestorage.com/${key}`;
}

function cleanBaseName(key: string): string {
  const parts = key.split('/');
  const file = parts[parts.length - 1];
  return file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

function detectStyle(text: string): string | undefined {
  const lower = text.toLowerCase();
  const styles = ['techno', 'house', 'trance', 'goa', 'psy', 'ambient', 'dub', 'electro', 'acid', 'industrial', 'minimal', 'hardcore', 'schranz', 'rave'];
  return styles.find((s) => lower.includes(s));
}

function detectCategoryType(text: string, ext: string): { category: string; type: string } {
  const lower = text.toLowerCase();
  if (/\b(kick|bass|sub|low)\b/.test(lower)) return { category: 'bass', type: 'Bass' };
  if (/\b(clap|snare|tom|perc|drum|kick)\b/.test(lower)) return { category: 'mids', type: 'Drum' };
  if (/\b(hat|hi.?hat)\b/.test(lower)) return { category: 'highs', type: 'Hat' };
  if (/\b(vocal|voice|acapella)\b/.test(lower)) return { category: 'mids', type: 'Vocal' };
  if (/\b(fx|sfx|effect|riser|impact|sweep)\b/.test(lower)) return { category: 'mids', type: 'FX' };
  if (/\b(lead|synth|pad|stab|chord)\b/.test(lower)) return { category: 'mids', type: 'Synth' };
  if (/\b(loop|groove|beat)\b/.test(lower)) return { category: 'mids', type: 'Loop' };
  if (/\b(stem|drums|bass|vocals|other|melody)\b/.test(lower)) return { category: 'mids', type: 'Stem' };
  if (/\.(mp3|m4a|webm|opus)$/i.test(ext)) return { category: 'mids', type: 'Track' };
  return { category: 'mids', type: 'Sample' };
}

function detectArtistTitle(key: string): { artist: string; title: string } {
  const base = cleanBaseName(key);
  const parts = base.split(' - ');
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: 'Unknown', title: base };
}

/** Analysiert einen R2-Objekt-Key regelbasiert (kostenlos, offline). */
export function analyzeAudioKey(key: string, fileSize?: number): AudioMetadata | null {
  const ext = (key.match(/\.[^.]+$/) ?? [''])[0];
  if (!AUDIO_EXT.test(key)) return null;

  const isMusic = /^music\//i.test(key) || /\.(mp3|m4a|webm|opus)$/i.test(key) || key.includes('music');
  const { artist, title } = detectArtistTitle(key);
  const { category, type } = detectCategoryType(key, ext);
  const style = detectStyle(key);
  const tags = [category, type.toLowerCase(), ...(style ? [style] : [])].filter(Boolean);

  return {
    kind: isMusic ? 'music' : 'sample',
    name: title,
    artist: isMusic ? artist : undefined,
    category,
    type,
    style,
    tags,
    url: r2PublicUrl(key),
    fileSize,
  };
}

/** Listet alle Audio-Objekte im R2-Bucket. */
export async function listR2Audio(): Promise<{ key: string; size?: number }[]> {
  const s3 = r2Client();
  if (!s3) throw new Error('R2 not configured (CFR2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY)');
  const bucket = env.CFR2_BUCKET?.trim() || 'audiomonastrysamples';
  const out: { key: string; size?: number }[] = [];
  let token: string | undefined;
  do {
    const cmd = new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token });
    const res = await s3.send(cmd);
    for (const obj of res.Contents ?? []) {
      if (obj.Key && AUDIO_EXT.test(obj.Key)) out.push({ key: obj.Key, size: obj.Size });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Ein einzelnes Audio-Objekt analysieren + in Supabase ablegen. */
export async function ingestAudioObject(key: string, fileSize?: number): Promise<{ key: string; ok: boolean; error?: string }> {
  const db = supabaseAdmin();
  if (!db) return { key, ok: false, error: 'supabase-not-configured' };
  const meta = analyzeAudioKey(key, fileSize);
  if (!meta) return { key, ok: false, error: 'not-audio' };

  if (meta.kind === 'music') {
    const { error } = await db.from('music_tracks').upsert({
      id: key,
      name: meta.name,
      artist: meta.artist ?? 'Unknown',
      url: meta.url,
      style: meta.style,
      tags: meta.tags,
    });
    if (error) return { key, ok: false, error: error.message };
    return { key, ok: true };
  }

  const { error } = await db.from('samples').upsert({
    id: key,
    name: meta.name,
    category: meta.category,
    type: meta.type,
    kind: 'sample',
    artist: meta.artist,
    style: meta.style,
    tags: meta.tags,
    url: meta.url,
    file_size: meta.fileSize,
    source: 'r2',
  });
  if (error) return { key, ok: false, error: error.message };

  // Tags normalisiert in sample_tags spiegeln.
  await db.from('sample_tags').delete().eq('sample_id', key);
  for (const tag of meta.tags) {
    await db.from('sample_tags').upsert({ sample_id: key, tag });
  }
  return { key, ok: true };
}

/** Bestehende R2-Audio-Objekte vollständig in Supabase einpflegen. */
export async function syncR2ToSupabase(): Promise<{ total: number; ok: number; failed: number; errors: string[] }> {
  const files = await listR2Audio();
  let ok = 0;
  const errors: string[] = [];
  for (const file of files) {
    const res = await ingestAudioObject(file.key, file.size);
    if (res.ok) ok++;
    else errors.push(`${res.key}: ${res.error ?? 'unbekannt'}`);
  }
  return { total: files.length, ok, failed: errors.length, errors: errors.slice(0, 20) };
}

export function cloudAutomationHealth(): { r2: boolean; supabase: boolean } {
  return { r2: Boolean(r2Client()), supabase: Boolean(supabaseAdmin()) };
}
