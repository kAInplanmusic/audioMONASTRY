/**
 * audioMONASTRY · Sample-Upload (ARCH-P2-002, Extraktion aus server.ts)
 * ====================================================================
 * Zwei Transportwege, EINE Verarbeitung:
 *
 *   1. POST /api/upload/sample             (multipart/form-data, ein Request)
 *   2. POST /api/upload/chunk/init         (FEAT-P3-003, unterbrechbar)
 *      PUT  /api/upload/chunk/:id/:index
 *      GET  /api/upload/chunk/:id
 *      POST /api/upload/chunk/:id/complete
 *
 * Beide Wege landen in `processSampleUpload` - Validierung, Scan ueber den
 * master-player, Ablage in R2 und Metadaten in Supabase sind identisch. Ein
 * zweiter, abweichender Pfad waere genau die Falle, die man spaeter nicht mehr
 * synchron haelt.
 *
 * Multipart-Felder: file (audio/*), kind (sample|recording|stem|sound|voice),
 * name, artist, style, key, bpm, tags (kommagetrennt), type
 * Ablauf: einlesen -> Format/Groesse pruefen -> Scan -> R2 (Supabase-Metadaten)
 *         -> Antwort mit URL.
 *
 * parseMultipartStream und getMasterPlayerUrl bleiben in server.ts: der Parser wird
 * auch von /api/separate-stems gebraucht, die Analyse-URL auch von der /api/master-
 * Familie. Beide werden deshalb gereicht (Referenz bzw. Getter), nicht kopiert.
 * AUDIO_EXT_RE, UPLOAD_KINDS und UPLOAD_MAX_MB wandern mit - sie werden nur hier
 * gebraucht.
 */
import { AudioSample } from '../../src/data/samples';
import { random } from '../../src/utils/random';
import { pushSampleToCloud, uploadSampleToR2 } from '../cloud.ts';
import { logR2Once, r2ProblemHint, toR2WriteError } from '../r2Health.ts';
import {
  ChunkUploadError,
  ChunkedUploadStore,
  DEFAULT_CHUNK_SIZE,
  uploadFingerprint,
  validateInitMeta,
  type ChunkUploadMeta,
} from '../chunkedUpload.ts';
import express from 'express';
import type { Express } from 'express';

/** Von server.ts gereichte Abhaengigkeiten (siehe Modul-Kommentar). */
export interface UploadDeps {
  getMasterPlayerUrl: () => string;
  parseMultipartStream: (req: import('http').IncomingMessage, maxFileBytes: number) => Promise<{ fields: Record<string, string>; files: { name: string; filename: string; contentType: string; data: Buffer }[] }>;
}

const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 100);
const UPLOAD_KINDS = new Set(['sample', 'recording', 'stem', 'sound', 'voice']);
const AUDIO_EXT_RE = /\.(wav|mp3|flac|ogg|m4a|aac|aiff|aif)$/i;

/** Ergebnis der gemeinsamen Verarbeitung - beide Transportwege antworten damit. */
export interface SampleUploadResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/**
 * Die EINE Verarbeitung eines vollstaendigen Uploads: validieren -> scannen ->
 * R2 -> Supabase. Wird von multipart UND Chunk-Abschluss benutzt, damit beide
 * Wege nicht auseinanderlaufen koennen.
 */
export async function processSampleUpload(
  input: { data: Buffer; filename: string; contentType?: string; fields: Record<string, string> },
  deps: Pick<UploadDeps, 'getMasterPlayerUrl'>,
): Promise<SampleUploadResult> {
  const { data } = input;
  const fields = input.fields ?? {};

  // --- Validierung ---
  const ext = (input.filename.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase();
  if (!AUDIO_EXT_RE.test(input.filename) && !(input.contentType || '').startsWith('audio/')) {
    return {
      httpStatus: 415,
      body: { status: 'error', message: `Nicht unterstütztes Audio-Format (.${ext || '?'}). Erlaubt: wav/mp3/flac/ogg/m4a/aac/aiff.` },
    };
  }
  if (data.length === 0) {
    return { httpStatus: 400, body: { status: 'error', message: 'Leere Datei.' } };
  }
  if (data.length > UPLOAD_MAX_MB * 1024 * 1024) {
    return { httpStatus: 413, body: { status: 'error', message: `Upload zu groß (max. ${UPLOAD_MAX_MB} MB).` } };
  }

  const kind = UPLOAD_KINDS.has(fields.kind) ? fields.kind : 'sample';
  const name = (fields.name || input.filename.replace(/\.[^.]+$/, '')).trim() || 'Upload';
  const tags = (fields.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const bpm = Number(fields.bpm);
  const style = (fields.style || '').trim();
  const artist = (fields.artist || '').trim();
  const key = (fields.key || '').trim();
  const type = (fields.type || kind).trim();

  // --- Scan (best effort über master-player, fällt bei Ausfall weich aus) ---
  let scan: any = null;
  try {
    const scanResp = await fetch(deps.getMasterPlayerUrl() + '/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: data.toString('base64') }),
    });
    if (scanResp.ok) scan = await scanResp.json();
  } catch { /* master-player optional */ }

  // --- Ablage: Audio nach R2, Metadaten nach Supabase ---
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'audio';
  const objectKey = `uploads/${kind}s/${Date.now()}-${safeName}.${ext || 'wav'}`;
  const uploaded = await uploadSampleToR2(objectKey, data, input.contentType || 'audio/wav');

  const sampleId = `${kind}-${Date.now().toString(36)}-${random().toString(36).slice(2, 7)}`;
  const category: AudioSample['category'] = kind === 'voice' || kind === 'recording' ? 'highs' : 'mids';
  const sample: AudioSample = {
    id: sampleId,
    name,
    category,
    type,
    url: uploaded.url,
    description: `Upload (${kind}) – gescannt am ${new Date().toISOString()}`,
    tags: [...tags, kind],
    parameters: {},
  };
  const db = await pushSampleToCloud(sample, {
    kind,
    artist: artist || null,
    style: style || null,
    key: key || null,
    bpm: Number.isFinite(bpm) ? bpm : null,
    duration_seconds: scan?.duration ?? null,
    sample_rate: scan?.sampleRate ?? null,
    lufs: scan?.lufs ?? null,
    file_size: data.length,
  });

  if (!db.ok) {
    return {
      httpStatus: 502,
      body: { status: 'error', message: 'Supabase-Ablage fehlgeschlagen: ' + (db.error ?? 'unbekannt'), sample, scan, storage: uploaded },
    };
  }

  return {
    httpStatus: 200,
    body: {
      status: 'ok',
      sample,
      meta: {
        kind,
        artist: artist || null,
        style: style || null,
        key: key || null,
        bpm: Number.isFinite(bpm) ? bpm : null,
      },
      scan,
      storage: uploaded,
      db,
    },
  };
}

export function registerUploadRoutes(app: Express, deps: UploadDeps): void {
  const { getMasterPlayerUrl, parseMultipartStream } = deps;
  const chunkStore = new ChunkedUploadStore();
  const maxBytes = UPLOAD_MAX_MB * 1024 * 1024;

  app.post('/api/upload/sample', async (req, res) => {
    if (!req.is('multipart/form-data')) {
      return res.status(415).json({ status: 'error', message: 'Erwartet multipart/form-data mit Feld "file".' });
    }
    try {
      // P-2/P-8: Streaming-Parser mit Limit – bricht zu große Uploads WÄHREND
      // des Lesens ab, statt erst nach Buffer.concat zu prüfen.
      const { fields, files } = await parseMultipartStream(req, maxBytes);
      const file = files[0];
      if (!file) return res.status(400).json({ status: 'error', message: 'Kein Datei-Feld "file" gefunden.' });

      const result = await processSampleUpload(
        { data: file.data, filename: file.filename, contentType: file.contentType, fields },
        { getMasterPlayerUrl },
      );
      return res.status(result.httpStatus).json(result.body);
    } catch (e) {
      // FIX F2: Der Live-Befund war `POST /api/upload/sample` → HTTP 500 mit dem
      // rohen SDK-Text „SignatureDoesNotMatch“. Die Ursache wird jetzt
      // klassifiziert: 503 = nicht konfiguriert (Client arbeitet lokal weiter),
      // 502 = konfiguriert, aber der Schreibzugriff scheitert (z. B. Signatur).
      const writeError = toR2WriteError(e);
      const unconfigured = writeError.problem === 'not-configured' || writeError.problem === 'bucket-missing';
      if (unconfigured) {
        logR2Once('upload:not-configured', `[upload] /api/upload/sample ohne R2-Konfiguration: ${writeError.message}`, 'warn');
      } else {
        logR2Once(
          `upload:${writeError.problem}`,
          `[upload] /api/upload/sample fehlgeschlagen [${writeError.problem}]: ${writeError.message}. ${r2ProblemHint(writeError.problem)}`,
        );
      }
      return res.status(unconfigured ? 503 : 502).json({
        status: 'error',
        error: unconfigured ? 'r2-not-configured' : 'r2-write-failed',
        reason: writeError.problem,
        degraded: true,
        hint: r2ProblemHint(writeError.problem),
        message: `Upload fehlgeschlagen: ${writeError.message}`,
      });
    }
  });

  /* ==================================================================
   * FEAT-P3-003: Chunk-Upload mit Wiederaufnahme
   * ================================================================== */

  const chunkErrorStatus = (error: unknown): number => {
    if (!(error instanceof ChunkUploadError)) return 500;
    if (error.code === 'UNKNOWN_UPLOAD') return 404;
    if (error.code === 'CHUNK_OUT_OF_RANGE' || error.code === 'CHUNK_TOO_LARGE'
      || error.code === 'CHUNK_SIZE_MISMATCH' || error.code === 'INVALID_META') return 400;
    if (error.code === 'INCOMPLETE' || error.code === 'SIZE_MISMATCH') return 409;
    return 500;
  };

  const errorBody = (error: unknown, code: string) => ({
    status: 'error',
    code: error instanceof ChunkUploadError ? error.code : code,
    message: (error as Error).message,
  });

  // Sitzung anlegen ODER eine abgebrochene mit gleichem Fingerabdruck fortsetzen.
  app.post('/api/upload/chunk/init', express.json({ limit: '256kb' }), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const { filename, size, chunkSize } = validateInitMeta({
        filename: body.filename,
        size: body.size,
        chunkSize: body.chunkSize ?? DEFAULT_CHUNK_SIZE,
        maxBytes,
      });
      const fields = (body.fields && typeof body.fields === 'object' ? body.fields : {}) as Record<string, string>;
      const fingerprint = typeof body.fingerprint === 'string' && body.fingerprint.length >= 8
        ? body.fingerprint
        : uploadFingerprint(filename, size, 0);
      const { status } = await chunkStore.init({
        filename,
        size,
        chunkSize,
        contentType: typeof body.contentType === 'string' ? body.contentType : undefined,
        fields,
        fingerprint,
      });
      return res.json({ status: 'ok', ...status, fingerprint, maxBytes });
    } catch (error) {
      return res.status(chunkErrorStatus(error)).json(errorBody(error, 'INIT_FAILED'));
    }
  });

  // Status: was liegt vor, was fehlt (= Wiederaufnahmepunkt).
  app.get('/api/upload/chunk/:uploadId', async (req, res) => {
    try {
      const status = await chunkStore.status(String(req.params.uploadId));
      return res.json({ status: 'ok', ...status });
    } catch (error) {
      return res.status(chunkErrorStatus(error)).json(errorBody(error, 'STATUS_FAILED'));
    }
  });

  // Einen Chunk schreiben. Roher Body (kein Multipart) - so kann der Client eine
  // File-Scheibe direkt senden, ohne sie vorher zu base64en.
  app.put(
    '/api/upload/chunk/:uploadId/:index',
    express.raw({ type: ['application/octet-stream', 'audio/*'], limit: '32mb' }),
    async (req, res) => {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        const status = await chunkStore.writeChunk(
          String(req.params.uploadId),
          Number(req.params.index),
          data,
        );
        return res.json({ status: 'ok', bytesWritten: data.length, ...status });
      } catch (error) {
        return res.status(chunkErrorStatus(error)).json(errorBody(error, 'CHUNK_FAILED'));
      }
    },
  );

  // Abschluss: zusammensetzen und ueber DIESELBE Pipeline verarbeiten.
  app.post('/api/upload/chunk/:uploadId/complete', async (req, res) => {
    let assembled: { meta: ChunkUploadMeta; data: Buffer; sha256: string } | null = null;
    try {
      assembled = await chunkStore.assemble(String(req.params.uploadId));
    } catch (error) {
      // Unvollstaendig/inkonsistent: kommt gar nicht bis zur Verarbeitung.
      return res.status(chunkErrorStatus(error)).json(errorBody(error, 'COMPLETE_FAILED'));
    }
    const { meta, data, sha256 } = assembled;
    try {
      const result = await processSampleUpload(
        { data, filename: meta.filename, contentType: meta.contentType, fields: meta.fields },
        { getMasterPlayerUrl },
      );
      // Erst NACH erfolgreicher Verarbeitung aufraeumen: scheitert die Ablage
      // (z. B. R2), bleibt die zusammengesetzte Datei fuer einen erneuten Versuch.
      const cleanedUp = result.httpStatus === 200;
      if (cleanedUp) await chunkStore.discard(meta.uploadId);
      return res.status(result.httpStatus).json({
        ...result.body,
        chunked: { uploadId: meta.uploadId, bytes: data.length, sha256, cleanedUp },
      });
    } catch (error) {
      // Die Datei war vollstaendig (sha256 ist berechnet), erst die Verarbeitung
      // scheiterte. Die Pruefsumme geht mit raus: der Client kann damit belegen,
      // was der Server zusammengesetzt hat, und ein Retry ist moeglich.
      return res.status(500).json({
        ...errorBody(error, 'PIPELINE_FAILED'),
        chunked: { uploadId: meta.uploadId, bytes: data.length, sha256, cleanedUp: false },
      });
    }
  });
}
