/**
 * audioMONASTRY · VisualMONK – Show-Merge (mehrere Clips → ein mp4)
 * ================================================================
 * Die Show besteht aus mehreren Wan2.2-Clips (480×832, 24 fps, ~5 s). Für den
 * Beamer ist das Abspielen in der App richtig; für „eine Datei zum Mitnehmen“
 * (Upload, Archiv, Projektion ohne Laptop) werden die Clips hier zu **einem**
 * mp4 mit einheitlichem Format zusammengeführt.
 *
 * Umsetzung: ffmpeg mit dem `concat`-Demuxer und anschließender Normalisierung
 * (`scale` + letterbox-`pad` + `fps` + `yuv420p`). Die Clips können
 * unterschiedliche Maße/Frameraten haben, deshalb wird **neu kodiert** statt
 * nur zu kopieren — ein reines `-c copy` bricht bei abweichenden
 * Auflösungen/Timebases mit sichtbaren Artefakten ab.
 *
 * Ehrliche Grenzen:
 * - ffmpeg muss vorhanden sein (`FFMPEG_PATH` oder im PATH). Fehlt es, gibt es
 *   `NO_FFMPEG` (HTTP 503) statt eines stillen Nicht-Ergebnisses.
 * - Ein einzelner Clip wird **nicht** neu kodiert, sondern unverändert
 *   zurückgegeben (kein Qualitätsverlust, keine Wartezeit).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { dataUriToBuffer, readArtifact } from './visionArtifacts.ts';

const execFileAsync = promisify(execFile);

export class MergeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MergeError';
    this.code = code;
  }
}

export interface MergeSource {
  name: string;
  bytes: Buffer;
}

export interface MergeOptions {
  width?: number;
  height?: number;
  fps?: number;
  timeoutMs?: number;
  ffmpegPath?: string;
}

/** Beamer-Format 16:9 (aus 480×832-Querformat abgeleitet, hochskaliert). */
const MERGE_DEFAULTS = { width: 1024, height: 576, fps: 24, timeoutMs: 300_000 };

/** Maximalgröße je Clip (Schutz gegen Riesen-Uploads über die API). */
export const MAX_MERGE_CLIP_BYTES = 12 * 1024 * 1024;

function ffmpegPath(): string {
  return (process.env.FFMPEG_PATH || '').trim() || 'ffmpeg';
}

/** Inhalt der ffmpeg-`concat`-Liste (Pfade werden gequotet). */
export function buildConcatFile(entries: readonly { file: string }[]): string {
  return entries.map((e) => `file '${e.file.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/** ffmpeg-Argumente für den Merge (deterministisch, damit testbar). */
export function buildMergeArgs(
  concatFile: string,
  outFile: string,
  opts: { width: number; height: number; fps: number },
): string[] {
  const { width, height, fps } = opts;
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
    'format=yuv420p',
  ].join(',');
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatFile,
    '-vf',
    filter,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    '-an',
    outFile,
  ];
}

let ffmpegProbe: Promise<boolean> | null = null;

/** Prüft einmalig, ob ffmpeg aufrufbar ist. */
function ffmpegAvailable(bin = ffmpegPath()): Promise<boolean> {
  if (!ffmpegProbe) {
    ffmpegProbe = execFileAsync(bin, ['-version'], { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
  }
  return ffmpegProbe;
}

/** Nur für Tests/Diagnose: Cache der ffmpeg-Prüfung zurücksetzen. */
export function resetFfmpegProbe(): void {
  ffmpegProbe = null;
}

export interface MergeResult {
  video: Buffer;
  bytes: number;
  mergeMs: number;
  clipCount: number;
  /** false = ein einzelner Clip wurde unverändert durchgereicht. */
  reencoded: boolean;
}

/**
 * Führt Clips zu einem mp4 zusammen. Reihenfolge = Show-Reihenfolge.
 * Wirft `MergeError` mit Code (`NO_FFMPEG`, `TIMEOUT`, `FFMPEG_FAILED`, …).
 */
export async function mergeClipBuffers(sources: readonly MergeSource[], opts: MergeOptions = {}): Promise<MergeResult> {
  const list = sources.filter((s) => s.bytes?.length > 0);
  if (list.length === 0) throw new MergeError('NO_SOURCES', 'keine Clips zum Zusammenfuehren');
  const started = Date.now();

  // Ein Clip: unverändert zurückgeben (kein sinnloser Re-Encode).
  if (list.length === 1) {
    return { video: list[0].bytes, bytes: list[0].bytes.length, mergeMs: Date.now() - started, clipCount: 1, reencoded: false };
  }

  const bin = opts.ffmpegPath || ffmpegPath();
  if (!(await ffmpegAvailable(bin))) {
    throw new MergeError('NO_FFMPEG', 'ffmpeg ist nicht installiert (FFMPEG_PATH oder PATH)');
  }

  const width = opts.width ?? MERGE_DEFAULTS.width;
  const height = opts.height ?? MERGE_DEFAULTS.height;
  const fps = opts.fps ?? MERGE_DEFAULTS.fps;
  const timeoutMs = opts.timeoutMs ?? MERGE_DEFAULTS.timeoutMs;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'amonk-show-'));
  const outFile = path.join(dir, 'show.mp4');

  try {
    const entries: { file: string }[] = [];
    for (let i = 0; i < list.length; i++) {
      // Dateinamen erzeugt der Server selbst (kein Nutzereinfluss).
      const file = path.join(dir, `clip-${String(i + 1).padStart(2, '0')}.mp4`);
      await writeFile(file, list[i].bytes);
      entries.push({ file });
    }
    const concatFile = path.join(dir, 'concat.txt');
    await writeFile(concatFile, buildConcatFile(entries), 'utf8');

    try {
      await execFileAsync(bin, buildMergeArgs(concatFile, outFile, { width, height, fps }), {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (e) {
      const err = e as Error & { killed?: boolean; signal?: string; code?: string; stderr?: string };
      if (err.code === 'ENOENT') throw new MergeError('NO_FFMPEG', 'ffmpeg nicht gefunden');
      if (err.killed || err.signal === 'SIGTERM') throw new MergeError('TIMEOUT', `Merge nach ${timeoutMs} ms abgebrochen`);
      const tail = String(err.stderr ?? err.message ?? '').trim().split('\n').slice(-2).join(' | ').slice(0, 300);
      throw new MergeError('FFMPEG_FAILED', tail || 'ffmpeg ist fehlgeschlagen');
    }

    const video = await readFile(outFile);
    if (video.length === 0) throw new MergeError('EMPTY_OUTPUT', 'ffmpeg lieferte eine leere Datei');
    return { video, bytes: video.length, mergeMs: Date.now() - started, clipCount: list.length, reencoded: true };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const ARTIFACT_PATH_PREFIX = '/api/ai/vision/artifact/';

/**
 * Holt das Material eines Show-Clips: `dataUri` direkt, `url` als R2-/HTTP-Link
 * **oder** als serverseitiger Artefakt-Pfad (dann wird die Datei direkt von der
 * Platte gelesen — kein HTTP, keine Auth-Frage).
 */
export async function loadMergeSource(
  entry: { url?: string; dataUri?: string; label?: string },
  index: number,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<MergeSource> {
  const name = (entry.label || `clip-${index + 1}.mp4`).slice(0, 80);
  if (entry.dataUri) {
    const bytes = dataUriToBuffer(entry.dataUri);
    if (!bytes || bytes.length === 0) throw new MergeError('BAD_SOURCE', `Clip ${index + 1}: dataUri unbrauchbar`);
    if (bytes.length > MAX_MERGE_CLIP_BYTES) throw new MergeError('TOO_LARGE', `Clip ${index + 1}: groesser als 12 MB`);
    return { name, bytes };
  }
  const url = String(entry.url ?? '').trim();
  if (!url) throw new MergeError('BAD_SOURCE', `Clip ${index + 1}: url/dataUri fehlt`);

  if (url.startsWith(ARTIFACT_PATH_PREFIX)) {
    const artifactName = decodeURIComponent(url.slice(ARTIFACT_PATH_PREFIX.length).split('?')[0]);
    const bytes = await readArtifact(artifactName);
    if (!bytes || bytes.length === 0) throw new MergeError('NOT_FOUND', `Clip ${index + 1}: Artefakt nicht gefunden`);
    return { name, bytes };
  }

  if (!/^https?:\/\//i.test(url)) throw new MergeError('BAD_SOURCE', `Clip ${index + 1}: nur http(s) oder dataUri erlaubt`);
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000);
  try {
    const resp = await doFetch(url, { signal: controller.signal });
    if (!resp.ok) throw new MergeError('FETCH_FAILED', `Clip ${index + 1}: HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) throw new MergeError('BAD_SOURCE', `Clip ${index + 1}: leer`);
    if (buf.length > MAX_MERGE_CLIP_BYTES) throw new MergeError('TOO_LARGE', `Clip ${index + 1}: groesser als 12 MB`);
    return { name, bytes: buf };
  } catch (e) {
    if (e instanceof MergeError) throw e;
    throw new MergeError('FETCH_FAILED', `Clip ${index + 1} nicht ladbar: ${String((e as Error).message).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
}
