/**
 * audioMONASTRY · Sample-Upload-Helfer (plattformneutral)
 * ========================================================
 * Validierung, Tagging und Metadaten-Aufbereitung für Audio-Uploads.
 * Genutzt von der Upload-UI und vom Server-Pendant (server.ts).
 */

export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'aiff', 'aif'] as const;
export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

export const UPLOAD_KINDS = ['sample', 'recording', 'stem', 'sound', 'voice'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export interface UploadMeta {
  kind: UploadKind;
  name: string;
  artist?: string;
  style?: string;
  key?: string;
  bpm?: number;
  tags: string[];
  type?: string;
}

export interface UploadValidation {
  ok: boolean;
  error?: string;
  ext?: AudioExtension;
}

/** Validiert Dateiname/-typ gegen die erlaubten Audio-Formate. */
export function validateAudioFile(filename: string, mimeType: string): UploadValidation {
  const ext = (filename.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase() as AudioExtension;
  if (!AUDIO_EXTENSIONS.includes(ext) && !mimeType.startsWith('audio/')) {
    return { ok: false, error: `Nicht unterstütztes Audio-Format (.${ext || '?'}). Erlaubt: ${AUDIO_EXTENSIONS.join('/')}` };
  }
  return { ok: true, ext };
}

/** Parst kommagetrennte Tags und ergänzt Pflicht-Tags (kind, Format). */
export function tagsFrom(input: string, kind: UploadKind, ext?: AudioExtension): string[] {
  const base = input.split(',').map((t) => t.trim()).filter(Boolean);
  const merged = new Set<string>([kind, ...(ext ? [ext] : []), ...base]);
  return [...merged];
}

/** Baut eine stabile Sample-ID für lokale Uploads (OPFS-Fallback). */
export function localSampleId(kind: UploadKind, name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'audio';
  return `${kind}-${Date.now().toString(36)}-${safe}`.slice(0, 80);
}

/** Erzeugt den Server-Objekt-Key (uploads/<kind>s/<zeit>-<name>.<ext>). */
export function uploadObjectKey(kind: UploadKind, name: string, ext?: AudioExtension): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'audio';
  return `uploads/${kind}s/${Date.now()}-${safe}.${ext || 'wav'}`;
}
