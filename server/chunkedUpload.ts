/**
 * audioMONASTRY · Chunked/Resumable Upload (FEAT-P3-003)
 * =====================================================================
 * Bisher gab es genau einen Weg fuer Uploads: `POST /api/upload/sample` mit
 * multipart/form-data in EINEM Request. Bei 100 MB Limit und mobilen Netzen ist
 * das die ungluecklichste Variante: bricht die Verbindung bei 95 %, sind 95 %
 * weg und der Nutzer laedt von vorn hoch.
 *
 * Dieses Modul liefert die Server-Seite fuer Chunk-Uploads mit Wiederaufnahme:
 *
 *   POST /api/upload/chunk/init            -> Sitzung anlegen ODER wiederfinden
 *   PUT  /api/upload/chunk/:id/:index      -> Chunk schreiben (idempotent)
 *   GET  /api/upload/chunk/:id             -> Status (was fehlt noch?)
 *   POST /api/upload/chunk/:id/complete    -> zusammensetzen + ueber die
 *                                             BESTEHENDE Pipeline verarbeiten
 *
 * Zwei Eigenschaften sind bewusst so gebaut:
 *
 *  1. **Positioniertes Schreiben.** Ein Chunk wird an seinen Offset
 *     geschrieben (`write(fd, buf, 0, len, offset)`) statt angehaengt. Damit ist
 *     ein erneut gesendeter Chunk idempotent - auch out-of-order - und ein
 *     abgebrochener Upload kann genau da weitermachen, wo er war.
 *  2. **Sitzung auf Platte.** Neben `<id>.part` liegt `<id>.json` mit den
 *     Metadaten. Deshalb ueberlebt die Wiederaufnahme nicht nur einen Abbruch im
 *     Browser, sondern auch einen Serverneustart (im Nachweis genau so geprueft);
 *     haelt man es nur im Speicher, waere nach jedem Deploy alles verloren.
 *
 * Kein Chunk wird ungeprueft akzeptiert: Index und Offset muessen zur
 * angekuendigten Groesse passen, ein zu grosser Chunk wird abgewiesen, und
 * `complete` verlangt die vollstaendige Datei - sonst kommt es gar nicht bis zur
 * Verarbeitung.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Chunk-Groesse (Default 4 MB): gross genug fuer Durchsatz, klein genug fuer Resume. */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
export const MIN_CHUNK_SIZE = 256 * 1024;
export const MAX_CHUNK_SIZE = 32 * 1024 * 1024;
/** Aufraeum-Alter: aeltere, nie fortgesetzte Uploads werden verworfen. */
export const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export interface ChunkUploadMeta {
  uploadId: string;
  /** Anzeigename der Datei (fuer die Ablage). */
  filename: string;
  size: number;
  contentType: string;
  chunkSize: number;
  /** Formularfelder (kind, name, tags, bpm, ...) - sie gehen an dieselbe Pipeline. */
  fields: Record<string, string>;
  /** Stabiler Fingerabdruck (Name+Groesse+Zeit): findet einen abgebrochenen Upload wieder. */
  fingerprint: string;
  /**
   * Schreibstand: Chunk-Index -> vollstaendig geschriebene Bytes.
   *
   * Bewusst in den Metadaten und nicht durch Ablesen der Datei: die Datei waechst
   * spaerlich (positioniertes Schreiben) und enthaelt fuer noch fehlende Chunks
   * schlicht nichts - ein "wie viele Bytes liegen vor" kann per Dateigroesse
   * nicht beantwortet werden, sobald out-of-order geschrieben wurde (ein erster
   * Entwurf mit vorab auf Zielgroesse gestutzter Datei zaehlte deshalb ALLE
   * Chunks als vorhanden - der Test hat genau das aufgedeckt). Als Metadatum ist
   * der Stand ausserdem ueber einen Serverneustart hinweg erhalten.
   */
  chunks: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

export interface ChunkUploadStatus {
  uploadId: string;
  filename: string;
  size: number;
  chunkSize: number;
  /** Indizes, die vollstaendig (in angekuendigter Groesse) vorliegen. */
  receivedChunks: number[];
  /** Indizes, die noch fehlen - in Reihenfolge. */
  missingChunks: number[];
  /** Naechster zu sendender Index (erster fehlender) oder null = vollstaendig. */
  nextIndex: number | null;
  receivedBytes: number;
  complete: boolean;
  /** true, wenn die Sitzung aus einer frueheren (auch serverseitig beendeten) Runde stammt. */
  resumed: boolean;
}

export class ChunkUploadError extends Error {
  readonly code:
    | 'UNKNOWN_UPLOAD'
    | 'INVALID_META'
    | 'CHUNK_OUT_OF_RANGE'
    | 'CHUNK_TOO_LARGE'
    | 'CHUNK_SIZE_MISMATCH'
    | 'INCOMPLETE'
    | 'SIZE_MISMATCH';

  constructor(code: ChunkUploadError['code'], message: string) {
    super(message);
    this.name = 'ChunkUploadError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Rein (ohne Dateisystem) - direkt testbar                            */
/* ------------------------------------------------------------------ */

/** Anzahl Chunks fuer eine Datei; eine leere Datei hat 0 Chunks. */
export function planChunks(size: number, chunkSize: number): number[] {
  if (!Number.isFinite(size) || size <= 0) return [];
  const count = Math.ceil(size / chunkSize);
  return Array.from({ length: count }, (_, i) => i);
}

/** Erwartete Groesse eines Chunks (der letzte darf kuerzer sein). */
export function expectedChunkSize(size: number, chunkSize: number, index: number): number {
  const start = index * chunkSize;
  return Math.max(0, Math.min(chunkSize, size - start));
}

/** Offset eines Chunks in der Zieldatei. */
export function chunkOffset(chunkSize: number, index: number): number {
  return index * chunkSize;
}

/**
 * Welche Chunks liegen vollstaendig vor? `written` ist Index -> geschriebene Bytes.
 * Ein halb geschriebener Chunk (Abbruch mitten im Chunk) zaehlt NICHT als
 * vorhanden - sonst wuerde die Wiederaufnahme eine Luecke ueberspringen.
 */
export function receivedChunks(
  size: number,
  chunkSize: number,
  written: Record<number, number>,
): number[] {
  return planChunks(size, chunkSize).filter((index) => {
    const have = written[index] ?? 0;
    return have >= expectedChunkSize(size, chunkSize, index);
  });
}

/** Fehlende Chunks in Reihenfolge. */
export function missingChunks(size: number, chunkSize: number, written: Record<number, number>): number[] {
  const have = new Set(receivedChunks(size, chunkSize, written));
  return planChunks(size, chunkSize).filter((index) => !have.has(index));
}

/** Erster fehlender Index (Wiederaufnahmepunkt) oder null wenn vollstaendig. */
export function nextMissingIndex(size: number, chunkSize: number, written: Record<number, number>): number | null {
  const missing = missingChunks(size, chunkSize, written);
  return missing.length > 0 ? missing[0] : null;
}

/** Stabiler Fingerabdruck fuer die Wiederaufnahme (gleiche Datei = gleiche Sitzung). */
export function uploadFingerprint(name: string, size: number, lastModified = 0): string {
  return createHash('sha256').update(`${name}|${size}|${lastModified}`).digest('hex').slice(0, 32);
}

/** Nur unkritische Dateinamen fuer die Ablage (der Name wird spaeter gesaeubert weiterverarbeitet). */
export function sanitizeUploadFileName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 200) || 'upload';
}

/** Validierung der Init-Metadaten (Groesse, Chunk-Groesse, Name). */
export function validateInitMeta(input: {
  filename?: unknown;
  size?: unknown;
  chunkSize?: unknown;
  maxBytes: number;
}): { filename: string; size: number; chunkSize: number } {
  const filename = sanitizeUploadFileName(String(input.filename ?? ''));
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) {
    throw new ChunkUploadError('INVALID_META', 'size muss eine positive Zahl sein');
  }
  if (size > input.maxBytes) {
    throw new ChunkUploadError('INVALID_META', `Datei zu gross (max. ${Math.round(input.maxBytes / 1024 / 1024)} MB)`);
  }
  const raw = Number(input.chunkSize);
  const chunkSize = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CHUNK_SIZE;
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new ChunkUploadError('CHUNK_SIZE_MISMATCH', `chunkSize muss zwischen ${MIN_CHUNK_SIZE} und ${MAX_CHUNK_SIZE} liegen`);
  }
  return { filename, size, chunkSize };
}

export function chunkUploadDir(): string {
  return (process.env.UPLOAD_CHUNK_DIR || '').trim() || path.join(tmpdir(), 'audiomonastry-uploads');
}

/* ------------------------------------------------------------------ */
/* Sitzungs-Ablage (Dateisystem)                                       */
/* ------------------------------------------------------------------ */

export class ChunkedUploadStore {
  constructor(
    private readonly dir: string = chunkUploadDir(),
    private readonly ttlMs: number = DEFAULT_UPLOAD_TTL_MS,
  ) {}

  private metaPath(uploadId: string): string {
    return path.join(this.dir, `${uploadId}.json`);
  }

  private partPath(uploadId: string): string {
    return path.join(this.dir, `${uploadId}.part`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Sitzung anlegen - oder eine bestehende (gleicher Fingerabdruck, gleiche Groesse) fortsetzen. */
  async init(input: {
    filename: string;
    size: number;
    chunkSize: number;
    contentType?: string;
    fields?: Record<string, string>;
    fingerprint?: string;
  }): Promise<{ meta: ChunkUploadMeta; status: ChunkUploadStatus }> {
    await this.ensureDir();
    await this.sweep();
    const fingerprint = input.fingerprint
      || uploadFingerprint(input.filename, input.size, 0);

    if (input.fingerprint) {
      const existing = await this.findByFingerprint(input.fingerprint, input.size);
      if (existing) {
        const status = await this.status(existing.uploadId);
        // Fortsetzen heisst: gleiche Datei, gleiche Groesse, neuere Felder gewinnen.
        const meta: ChunkUploadMeta = {
          ...existing,
          fields: { ...existing.fields, ...(input.fields ?? {}) },
          updatedAt: Date.now(),
        };
        await writeFile(this.metaPath(meta.uploadId), JSON.stringify(meta), 'utf8');
        return { meta, status: { ...status, resumed: true } };
      }
    }

    const uploadId = randomUUID();
    const now = Date.now();
    const meta: ChunkUploadMeta = {
      uploadId,
      filename: input.filename,
      size: input.size,
      contentType: input.contentType || 'application/octet-stream',
      chunkSize: input.chunkSize,
      fields: input.fields ?? {},
      fingerprint,
      chunks: {},
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(this.metaPath(uploadId), JSON.stringify(meta), 'utf8');
    // Leere Datei anlegen; das positionierte Schreiben dehnt sie spaerlich aus.
    const handle = await open(this.partPath(uploadId), 'w');
    await handle.close();
    return { meta, status: { ...(await this.status(uploadId)), resumed: false } };
  }

  private async findByFingerprint(fingerprint: string, size: number): Promise<ChunkUploadMeta | null> {
    const metas = await this.list();
    return metas.find((m) => m.fingerprint === fingerprint && m.size === size) ?? null;
  }

  async list(): Promise<ChunkUploadMeta[]> {
    try {
      const entries = await readdir(this.dir);
      const metas: ChunkUploadMeta[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          metas.push(JSON.parse(await readFile(path.join(this.dir, entry), 'utf8')) as ChunkUploadMeta);
        } catch { /* kaputte Metadaten ignorieren */ }
      }
      return metas;
    } catch {
      return [];
    }
  }

  async readMeta(uploadId: string): Promise<ChunkUploadMeta> {
    try {
      return JSON.parse(await readFile(this.metaPath(uploadId), 'utf8')) as ChunkUploadMeta;
    } catch {
      throw new ChunkUploadError('UNKNOWN_UPLOAD', `unbekannte Upload-Sitzung: ${uploadId}`);
    }
  }

  /**
   * Bereits geschriebene Bytes je Chunk - aus den durabelen Metadaten. Die
   * Dateigroesse taugt dafuer nicht (siehe `chunks` in ChunkUploadMeta).
   */
  private writtenMap(meta: ChunkUploadMeta): Record<number, number> {
    const written: Record<number, number> = {};
    for (const [key, value] of Object.entries(meta.chunks ?? {})) {
      const index = Number(key);
      if (Number.isInteger(index) && Number.isFinite(value)) written[index] = Number(value);
    }
    return written;
  }

  async status(uploadId: string): Promise<ChunkUploadStatus> {
    const meta = await this.readMeta(uploadId);
    const written = this.writtenMap(meta);
    const have = receivedChunks(meta.size, meta.chunkSize, written);
    const missing = missingChunks(meta.size, meta.chunkSize, written);
    const receivedBytes = have.reduce((sum, index) => sum + expectedChunkSize(meta.size, meta.chunkSize, index), 0);
    return {
      uploadId: meta.uploadId,
      filename: meta.filename,
      size: meta.size,
      chunkSize: meta.chunkSize,
      receivedChunks: have,
      missingChunks: missing,
      nextIndex: nextMissingIndex(meta.size, meta.chunkSize, written),
      receivedBytes,
      complete: missing.length === 0 && meta.size > 0,
      resumed: false,
    };
  }

  /** Einen Chunk an seinen Offset schreiben. Mehrfaches Senden ist erlaubt (idempotent). */
  async writeChunk(uploadId: string, index: number, data: Buffer): Promise<ChunkUploadStatus> {
    const meta = await this.readMeta(uploadId);
    const total = planChunks(meta.size, meta.chunkSize).length;
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      throw new ChunkUploadError('CHUNK_OUT_OF_RANGE', `Chunk-Index ${index} liegt ausserhalb (0..${total - 1})`);
    }
    const want = expectedChunkSize(meta.size, meta.chunkSize, index);
    if (data.length > want) {
      throw new ChunkUploadError('CHUNK_TOO_LARGE', `Chunk ${index} hat ${data.length} Bytes, erwartet hoechstens ${want}`);
    }
    const handle = await open(this.partPath(uploadId), 'r+');
    try {
      await handle.write(data, 0, data.length, chunkOffset(meta.chunkSize, index));
    } finally {
      await handle.close();
    }
    // Erst die Daten, dann der Stand: bricht es dazwischen ab, gilt der Chunk als
    // fehlend und wird erneut gesendet (idempotent) - nie umgekehrt.
    const chunks = { ...(meta.chunks ?? {}), [index]: data.length };
    await writeFile(this.metaPath(uploadId), JSON.stringify({ ...meta, chunks, updatedAt: Date.now() }), 'utf8');
    return { ...(await this.status(uploadId)), resumed: false };
  }

  /** Zusammensetzen: nur bei vollstaendiger Datei. Gibt die Bytes + die Metadaten zurueck. */
  async assemble(uploadId: string): Promise<{ meta: ChunkUploadMeta; data: Buffer; sha256: string }> {
    const meta = await this.readMeta(uploadId);
    const status = await this.status(uploadId);
    if (!status.complete) {
      throw new ChunkUploadError(
        'INCOMPLETE',
        `Upload unvollstaendig: ${status.missingChunks.length} Chunk(s) fehlen (naechster: ${status.nextIndex})`,
      );
    }
    const data = await readFile(this.partPath(uploadId));
    if (data.length !== meta.size) {
      throw new ChunkUploadError('SIZE_MISMATCH', `zusammengesetzt: ${data.length} Bytes, angekuendigt: ${meta.size}`);
    }
    return { meta, data, sha256: createHash('sha256').update(data).digest('hex') };
  }

  /** Temp-Dateien einer abgeschlossenen Sitzung entfernen. */
  async discard(uploadId: string): Promise<void> {
    await rm(this.partPath(uploadId), { force: true });
    await rm(this.metaPath(uploadId), { force: true });
  }

  /** Abgebrochene Uploads, die nie fortgesetzt wurden, nach `ttlMs` verwerfen. */
  async sweep(now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    for (const meta of await this.list()) {
      if (now - (meta.updatedAt || meta.createdAt || 0) > this.ttlMs) {
        await this.discard(meta.uploadId);
        removed.push(meta.uploadId);
      }
    }
    return removed;
  }
}
