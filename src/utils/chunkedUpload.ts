/**
 * audioMONASTRY · Chunk-Upload vom Client (FEAT-P3-003)
 * =====================================================================
 * Gegenstueck zu `server/chunkedUpload.ts`. Der Nutzen entsteht erst hier:
 *
 *   - Die Datei wird in Chunks gesendet, der Fortschritt ist sichtbar.
 *   - Bricht es ab (Netz, Tab zu, Serverneustart), findet der naechste Versuch
 *     die Sitzung ueber den Fingerabdruck wieder und sendet NUR die fehlenden
 *     Chunks. Der Fingerabdruck ist `name|size|lastModified` - stabil ueber
 *     einen Reload hinweg, weil der Browser die Datei-Metadaten behaelt.
 *   - 429 (Rate-Limit) und 5xx werden mit Backoff wiederholt; ein echter
 *     Abbruch (`AbortSignal`) beendet die Schleife sofort und laesst die Sitzung
 *     serverseitig stehen - genau das macht den naechsten Versuch billig.
 *
 * `fetchImpl` ist injizierbar, damit die Resume-/Retry-Logik ohne Netz testbar
 * ist (siehe tests/chunkedUploadClient.test.ts).
 */

// F5-Fix: Der Server zaehlt Rate-Limits je Nutzer-/Session-Identitaet statt je
// Master-Token (server/rateLimitKeys.ts). Der Chunk-Upload ist der
// hochfrequenteste Pfad der App – er muss sein eigenes Budget behalten.
import { sessionIdentityHeaders } from '../core/session/sessionIdentity';

export interface ChunkUploadStatusResponse {
  uploadId: string;
  filename: string;
  size: number;
  chunkSize: number;
  receivedChunks: number[];
  missingChunks: number[];
  nextIndex: number | null;
  receivedBytes: number;
  complete: boolean;
  resumed: boolean;
}

export interface ChunkedUploadOptions {
  chunkSize?: number;
  fields?: Record<string, string>;
  kind?: string;
  onProgress?: (info: { sentBytes: number; totalBytes: number; percent: number; resumed: boolean }) => void;
  signal?: AbortSignal;
  /** Anzahl Versuche pro Chunk (429/5xx/Netzfehler), Default 4. */
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  /** Kurz-Sleep injizierbar (Tests laufen ohne echte Wartezeit). */
  sleep?: (ms: number) => Promise<void>;
}

export class ChunkedUploadError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = 'ChunkedUploadError';
    this.status = status;
    this.code = code;
  }
}

/** Stabiler Fingerabdruck der Datei (gleiche Datei = gleicher Upload). */
export function fileFingerprint(file: { name: string; size: number; lastModified?: number }): string {
  const raw = `${file.name}|${file.size}|${file.lastModified ?? 0}`;
  // FNV-1a: reicht hier voellig (keine Sicherheitsfunktion, nur Wiedererkennung).
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `f${hash.toString(16)}${raw.length.toString(16)}`;
}

/** Chunks, die dieser Client noch senden muss - in Reihenfolge. */
export function chunksToSend(status: Pick<ChunkUploadStatusResponse, 'missingChunks'>): number[] {
  return [...status.missingChunks].sort((a, b) => a - b);
}

/** Prozentwerte fuer die Anzeige (0..100, ganzzahlig). */
export function progressPercent(sentBytes: number, totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((sentBytes / totalBytes) * 100)));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wartezeit vor dem naechsten Versuch: 0.5 s, 1 s, 2 s ... (429 laenger). */
export function retryDelayMs(attempt: number, status = 0): number {
  const base = status === 429 ? 2000 : 500;
  return Math.min(30_000, base * 2 ** Math.max(0, attempt - 1));
}

async function readError(res: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = await res.json() as { message?: string; code?: string; error?: string };
    return { message: body.message ?? body.error ?? `HTTP ${res.status}`, code: body.code };
  } catch {
    return { message: `HTTP ${res.status}` };
  }
}

/**
 * Laedt eine Datei in Chunks hoch und setzt einen abgebrochenen Upload fort.
 * Gibt die Server-Antwort von `complete` zurueck (gleiche Form wie der
 * Multipart-Upload, inkl. `sample`).
 */
export async function uploadFileInChunks(
  file: File,
  options: ChunkedUploadOptions = {},
): Promise<Record<string, unknown>> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const chunkSize = options.chunkSize ?? 4 * 1024 * 1024;
  const fingerprint = fileFingerprint(file);
  const fields = { ...(options.fields ?? {}) };
  if (options.kind && !fields.kind) fields.kind = options.kind;

  const ensureNotAborted = () => {
    if (options.signal?.aborted) throw new ChunkedUploadError('Upload abgebrochen', 0, 'ABORTED');
  };

  // 1) Sitzung anlegen ODER fortsetzen (der Server entscheidet anhand des Fingerabdrucks).
  const initRes = await doFetch('/api/upload/chunk/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sessionIdentityHeaders() },
    body: JSON.stringify({
      filename: file.name,
      size: file.size,
      chunkSize,
      contentType: file.type || 'application/octet-stream',
      fields,
      fingerprint,
    }),
    signal: options.signal,
  });
  if (!initRes.ok) {
    const { message, code } = await readError(initRes);
    throw new ChunkedUploadError(`Upload konnte nicht gestartet werden: ${message}`, initRes.status, code);
  }
  const status = await initRes.json() as ChunkUploadStatusResponse;
  const totalBytes = status.size || file.size;
  let sentBytes = Math.min(status.receivedBytes ?? 0, totalBytes);
  options.onProgress?.({ sentBytes, totalBytes, percent: progressPercent(sentBytes, totalBytes), resumed: status.resumed });

  // 2) Nur die fehlenden Chunks senden.
  for (const index of chunksToSend(status)) {
    ensureNotAborted();
    const start = index * (status.chunkSize || chunkSize);
    const end = Math.min(file.size, start + (status.chunkSize || chunkSize));
    const blob = file.slice(start, end);
    const body = await blob.arrayBuffer();

    let lastError: ChunkedUploadError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      ensureNotAborted();
      // `terminal` statt eines direkten `throw` im try: ein Throw waere vom
      // eigenen catch als "Netzfehler" wieder eingesammelt und der 4xx wuerde
      // trotzdem wiederholt (genau das hat tests/chunkedUploadClient.test.ts
      // aufgedeckt).
      let terminal = false;
      try {
        const res = await doFetch(`/api/upload/chunk/${status.uploadId}/${index}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', ...sessionIdentityHeaders() },
          body,
          signal: options.signal,
        });
        if (res.ok) {
          sentBytes += body.byteLength;
          options.onProgress?.({ sentBytes, totalBytes, percent: progressPercent(sentBytes, totalBytes), resumed: false });
          lastError = null;
          break;
        }
        const { message, code } = await readError(res);
        lastError = new ChunkedUploadError(`Chunk ${index} abgelehnt: ${message}`, res.status, code);
        // 4xx (ausser 429) sind endgueltig - ein Retry wuerde nur Zeit kosten.
        if (res.status < 500 && res.status !== 429) terminal = true;
      } catch (error) {
        if (error instanceof ChunkedUploadError && error.code === 'ABORTED') throw error;
        if (options.signal?.aborted) throw new ChunkedUploadError('Upload abgebrochen', 0, 'ABORTED');
        lastError = error instanceof ChunkedUploadError
          ? error
          : new ChunkedUploadError(`Netzfehler bei Chunk ${index}: ${(error as Error).message}`);
      }
      if (terminal) break;
      if (attempt < maxAttempts) await sleep(retryDelayMs(attempt, lastError.status));
    }
    if (lastError) {
      // Sitzung bleibt bestehen: der naechste Aufruf setzt hier fort.
      throw lastError;
    }
  }

  // 3) Abschluss: der Server setzt zusammen und verarbeitet ueber die gemeinsame Pipeline.
  const completeRes = await doFetch(`/api/upload/chunk/${status.uploadId}/complete`, {
    method: 'POST',
    headers: { ...sessionIdentityHeaders() },
    signal: options.signal,
  });
  const payload = await completeRes.json().catch(() => ({})) as Record<string, unknown>;
  if (!completeRes.ok) {
    const message = String(payload.message ?? `HTTP ${completeRes.status}`);
    throw new ChunkedUploadError(`Upload fehlgeschlagen: ${message}`, completeRes.status, payload.code as string | undefined);
  }
  return payload;
}
