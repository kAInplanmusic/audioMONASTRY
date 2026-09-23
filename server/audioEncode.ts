/**
 * audioMONASTRY · Codec-Export für Mixdown/Master (FEAT-P3-004)
 * =====================================================================
 * Export und Bounce konnten bisher nur WAV (`encodeWavFromChannels` im Client).
 * Dieses Modul ergänzt MP3, FLAC, AAC (M4A-Container) und OGG – serverseitig
 * über ffmpeg, nach demselben Muster wie der Show-Merge in
 * `server/visionShow.ts`:
 *
 *   * reine, deterministische Argument-Bauer (`buildEncodeArgs`,
 *     `exportFormatInfo`) → ohne ffmpeg testbar,
 *   * ein dünner Runner (`encodeAudioBuffer`), der Eingabe/Binär-Ausgabe
 *     korrekt behandelt und typisierte Fehler wirft,
 *   * ehrliches Verhalten ohne ffmpeg: `NO_FFMPEG` statt still zu scheitern.
 *
 * Metadaten: Titel/Interpret/Album/Kommentar werden als ffmpeg-`-metadata`
 * geschrieben (MP3 als ID3v2.3, damit auch ältere Player die Tags lesen).
 * WAV bleibt ein Durchlauf ohne ffmpeg (bit-identisch zum Client-Bounce).
 *
 * ffmpeg-Binary: `FFMPEG_PATH` oder PATH (wie `server/visionShow.ts`).
 */
import {
  AUDIO_EXPORT_FORMATS,
  exportFileName,
  exportFormatInfo,
  type AudioExportFormat,
  type ExportFormatInfo,
} from '../src/utils/audioExportFormats';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Timeout der ffmpeg-Verfuegbarkeitsprobe (grosszuegig: Last-Peaks). */
const FFMPEG_PROBE_TIMEOUT_MS = 30_000;

export type AudioEncodeErrorCode = 'UNKNOWN_FORMAT' | 'EMPTY_INPUT' | 'NO_FFMPEG' | 'ENCODE_FAILED';

// Eine Quelle fuer Namen/Endungen/MIME-Typen: die UI-Auswahl (Terminal) und die
// Auslieferung (diese Route) duerfen nicht auseinanderlaufen.
export { AUDIO_EXPORT_FORMATS, exportFileName, exportFormatInfo };
export type { AudioExportFormat, ExportFormatInfo };

export class AudioEncodeError extends Error {
  readonly code: AudioEncodeErrorCode;

  constructor(code: AudioEncodeErrorCode, message: string) {
    super(message);
    this.name = 'AudioEncodeError';
    this.code = code;
  }
}

export interface EncodeMetadata {
  title?: string;
  artist?: string;
  album?: string;
  comment?: string;
}

/** Rohwerte für Metadaten bereinigen (keine Zeilenumbrüche, Längen begrenzt). */
export function sanitizeMetadataValue(raw: unknown, maxLength = 200): string {
  return String(raw ?? '')
    .replace(/[\r\n\t\0]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** ffmpeg-Argumente für die Metadaten (nur gesetzte Felder). */
export function buildMetadataArgs(metadata: EncodeMetadata = {}): string[] {
  const args: string[] = [];
  for (const [key, value] of [
    ['title', metadata.title],
    ['artist', metadata.artist],
    ['album', metadata.album],
    ['comment', metadata.comment],
  ] as const) {
    const clean = sanitizeMetadataValue(value);
    if (clean) args.push('-metadata', `${key}=${clean}`);
  }
  return args;
}

export interface BuildEncodeArgsOptions extends EncodeMetadata {
  /** Nur für `argStyle: 'bitrate'`; ohne Angabe gilt `defaultBitrateKbps`. */
  bitrateKbps?: number;
  /** Nur für `argStyle: 'quality'` (libvorbis); ohne Angabe gilt `defaultQuality`. */
  quality?: number;
}

/**
 * Deterministische ffmpeg-Argumente (ohne Binary) – damit ist die Umsetzung
 * testbar, ohne einen echten Encoder zu brauchen.
 */
export function buildEncodeArgs(
  inputPath: string,
  outputPath: string,
  info: ExportFormatInfo,
  options: BuildEncodeArgsOptions = {},
): string[] {
  if (!info.codec) {
    throw new AudioEncodeError('UNKNOWN_FORMAT', `${info.format} braucht keinen Encoder (WAV-Durchlauf)`);
  }
  // PROTOKOLL-WHITELIST (Block 2 / Angriff 4, 2026-09-23): ohne sie darf ffmpeg
  // ueber JEDES Protokoll lesen, das sein Build kennt - auch http/https/rtmp/
  // tcp. Der Eingabepfad ist hier immer eine Datei, die der Server selbst in
  // einem mkdtemp-Verzeichnis angelegt hat; mehr wird nicht gebraucht. Ein
  // manipulierter Eingabename koennte sonst als URL gedeutet werden und ffmpeg
  // zu einem Netzzugriff veranlassen (SSRF ueber den Mediaparser). `file` steht
  // VOR dem `-i` - es ist eine Eingabeoption.
  const args = [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-protocol_whitelist',
    'file',
    '-i',
    inputPath,
    '-vn',
    '-c:a',
    info.codec,
  ];
  if (info.argStyle === 'quality') {
    const quality = Number(options.quality ?? info.defaultQuality ?? 6);
    const clamped = Number.isFinite(quality) ? Math.min(10, Math.max(0, quality)) : 6;
    args.push('-q:a', String(clamped));
  } else {
    const bitrate = Number(options.bitrateKbps ?? info.defaultBitrateKbps ?? 0);
    if (!info.lossless && Number.isFinite(bitrate) && bitrate > 0) {
      args.push('-b:a', `${Math.round(bitrate)}k`);
    }
  }
  if (info.codec === 'flac') {
    // Verlustfrei und ohne Encoder-Streuung: feste Kompressionsstufe.
    args.push('-compression_level', '8');
  }
  if (info.format === 'mp3') {
    // ID3v2.3 schreibt praktisch jeder Player.
    args.push('-id3v2_version', '3');
  }
  args.push(...buildMetadataArgs(options), outputPath);
  return args;
}

/** ffmpeg-Binary wie in `server/visionShow.ts` (`FFMPEG_PATH` oder PATH). */
export function ffmpegPath(): string {
  return (process.env.FFMPEG_PATH || '').trim() || 'ffmpeg';
}

let ffmpegProbe: Promise<boolean> | null = null;

/**
 * Prüft, ob ffmpeg aufrufbar ist. Nur ein ERFOLGREICHER Probe wird gecacht -
 * ein transienter Fehlschlag (Prozess-Limit, kurzer Last-Peak) darf den
 * Export nicht dauerhaft abschalten. Live beobachtet 2026-09-17 im vollen
 * Gate-Lauf: der 10-s-Probe lief unter paralleler Last in seinen Timeout und
 * der ganze Exporter meldete danach NO_FFMPEG, obwohl ffmpeg vorhanden war.
 */
export function ffmpegAvailable(bin = ffmpegPath()): Promise<boolean> {
  if (ffmpegProbe) return ffmpegProbe;
  const probe = execFileAsync(bin, ['-version'], { timeout: FFMPEG_PROBE_TIMEOUT_MS }).then(
    () => true,
    () => false,
  );
  ffmpegProbe = probe;
  void probe.then((available) => {
    // Fehlschlag NICHT cachen: der naechste Aufruf probiert erneut.
    if (!available && ffmpegProbe === probe) ffmpegProbe = null;
  });
  return probe;
}

/** Nur für Tests/Diagnose: Cache der ffmpeg-Prüfung zurücksetzen. */
export function resetFfmpegProbe(): void {
  ffmpegProbe = null;
}

export interface EncodeResult {
  data: Buffer;
  info: ExportFormatInfo;
}

/**
 * Kodiert einen WAV-Puffer in das Zielformat.
 * WAV läuft unverändert durch (kein ffmpeg, bit-identisch).
 */
export async function encodeAudioBuffer(
  input: Buffer,
  format: unknown,
  options: BuildEncodeArgsOptions & { ffmpegBin?: string } = {},
): Promise<EncodeResult> {
  const info = exportFormatInfo(format);
  if (!info) {
    throw new AudioEncodeError('UNKNOWN_FORMAT', `unbekanntes Exportformat: ${String(format ?? '')}`);
  }
  if (!input || input.length === 0) {
    throw new AudioEncodeError('EMPTY_INPUT', 'leerer Audio-Puffer');
  }
  if (!info.codec) {
    return { data: input, info };
  }

  const bin = options.ffmpegBin || ffmpegPath();
  if (!(await ffmpegAvailable(bin))) {
    throw new AudioEncodeError('NO_FFMPEG', `ffmpeg nicht aufrufbar (${bin})`);
  }

  const workDir = await mkdtemp(join(tmpdir(), 'audiomonastry-encode-'));
  const inputPath = join(workDir, 'input.wav');
  const outputPath = join(workDir, `output.${info.extension}`);
  try {
    await writeFile(inputPath, input);
    const args = buildEncodeArgs(inputPath, outputPath, info, options);
    try {
      await execFileAsync(bin, args, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      const e = error as { stderr?: string; message?: string };
      throw new AudioEncodeError('ENCODE_FAILED', sanitizeMetadataValue(e.stderr || e.message || 'ffmpeg-Fehler', 300));
    }
    return { data: await readFile(outputPath), info };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
