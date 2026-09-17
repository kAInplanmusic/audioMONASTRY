/**
 * audioMONASTRY · Export-Formate für Mixdown/Master (FEAT-P3-004)
 * =====================================================================
 * Client-sichere Beschreibung der Export-Formate (keine Node-/ffmpeg-Imports):
 * die Terminal-UI baut daraus die Auswahl, `server/audioEncode.ts` daraus die
 * ffmpeg-Argumente. Eine Quelle für Namen, Endungen und MIME-Typen, damit
 * Auswahl und Auslieferung nicht auseinanderlaufen.
 *
 * AAC liegt bewusst im M4A-Container (`audio/mp4`): nur so sind Metadaten
 * möglich - der ADTS-Muxer kennt keine Tags.
 */

export type AudioExportFormat = 'wav' | 'mp3' | 'flac' | 'aac' | 'ogg';

export interface ExportFormatInfo {
  /** Kanonischer Name in der API (`?format=`). */
  format: AudioExportFormat;
  /** Dateiendung ohne Punkt. */
  extension: string;
  mimeType: string;
  /** ffmpeg-Encoder (`-c:a`); leer = kein ffmpeg nötig (WAV-Durchlauf). */
  codec: string;
  lossless: boolean;
  /** Wie die Qualität gesteuert wird: CBR-Bitrate oder VBR-Qualitätsstufe. */
  argStyle?: 'bitrate' | 'quality';
  /** Vorgabe für verlustbehaftete Formate; per `bitrateKbps` überschreibbar. */
  defaultBitrateKbps?: number;
  /** Vorgabe für `argStyle: 'quality'` (libvorbis `-q:a`, 0..10). */
  defaultQuality?: number;
  /** Aliase, die ebenfalls akzeptiert werden (z. B. `m4a`). */
  aliases?: readonly string[];
  /** Kurzlabel für die UI. */
  label: string;
}

export const AUDIO_EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  { format: 'wav', extension: 'wav', mimeType: 'audio/wav', codec: '', lossless: true, label: 'WAV · verlustfrei' },
  { format: 'flac', extension: 'flac', mimeType: 'audio/flac', codec: 'flac', lossless: true, label: 'FLAC · verlustfrei' },
  { format: 'mp3', extension: 'mp3', mimeType: 'audio/mpeg', codec: 'libmp3lame', lossless: false, argStyle: 'bitrate', defaultBitrateKbps: 320, label: 'MP3 · 320 kbps' },
  { format: 'aac', extension: 'm4a', mimeType: 'audio/mp4', codec: 'aac', lossless: false, argStyle: 'bitrate', defaultBitrateKbps: 256, aliases: ['m4a', 'mp4'], label: 'AAC (M4A) · 256 kbps' },
  // OGG bewusst VBR (`-q:a`): libvorbis lehnt hohe CBR-Bitraten je nach Kanalzahl
  // ab - live gemessen 2026-09-17 scheiterte `-b:a 256k` bei Mono/44,1 kHz mit
  // "encoder setup failed", während `-q:a 6` in jedem Fall funktioniert.
  { format: 'ogg', extension: 'ogg', mimeType: 'audio/ogg', codec: 'libvorbis', lossless: false, argStyle: 'quality', defaultQuality: 6, label: 'OGG Vorbis · VBR q6' },
];

/** Formatinfo zum kanonischen Namen oder Alias; `null` = unbekannt. */
export function exportFormatInfo(raw: unknown): ExportFormatInfo | null {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!name) return null;
  for (const info of AUDIO_EXPORT_FORMATS) {
    if (info.format === name) return info;
    if (info.aliases?.includes(name)) return info;
  }
  return null;
}

/** Dateiname für `Content-Disposition`/Download (ohne Pfad-/Header-Sonderzeichen). */
export function exportFileName(info: ExportFormatInfo, baseName = 'audiomonastry-mixdown'): string {
  const safeBase = String(baseName ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    // Führende Punkte/Bindestriche entfernen: sonst könnte ".." im
    // Content-Disposition-Dateinamen stehen (Pfad-Andeutung).
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 80) || 'audiomonastry-mixdown';
  return `${safeBase}.${info.extension}`;
}
