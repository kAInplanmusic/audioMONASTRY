/**
 * audioMONASTRY · Sample-Upload (ARCH-P2-002, Extraktion aus server.ts)
 * ====================================================================
 *   POST /api/upload/sample  (multipart/form-data)
 *     Felder: file (audio/*), kind (sample|recording|stem|sound|voice), name,
 *             artist, style, key, bpm, tags (kommagetrennt), type
 *     Ablauf: Multipart einlesen -> Format/Groesse pruefen -> Scan-Schritt ueber den
 *             master-player -> Ablage in R2 (Supabase-Metadaten) -> Antwort mit URL.
 * 
 * parseMultipartStream und getMasterPlayerUrl bleiben in server.ts: der Parser wird
 * auch von /api/separate-stems gebraucht, die Analyse-URL auch von der /api/master-
 * Familie. Beide werden deshalb gereicht (Referenz bzw. Getter), nicht kopiert.
 * AUDIO_EXT_RE, UPLOAD_KINDS und UPLOAD_MAX_MB wandern mit - sie werden nur hier
 * gebraucht.
 * 
 * Der Code wurde 1:1 verschoben; die Einrueckung ist die einzige Aenderung.
 */
import { AudioSample } from '../../src/data/samples';
import { random } from '../../src/utils/random';
import { pushSampleToCloud, uploadSampleToR2 } from '../cloud.ts';
import type { Express } from 'express';

/** Von server.ts gereichte Abhaengigkeiten (siehe Modul-Kommentar). */
export interface UploadDeps {
  getMasterPlayerUrl: () => string;
  parseMultipartStream: (req: import('http').IncomingMessage, maxFileBytes: number) => Promise<{ fields: Record<string, string>; files: { name: string; filename: string; contentType: string; data: Buffer }[] }>;
}

// ===========================================================================
// Sample-Upload mit Scan + korrekter Ablage (R2 + Supabase)
//   POST /api/upload/sample  (multipart/form-data)
//   Felder: file (audio/*), kind (sample|recording|stem|sound|voice),
//           name, artist, style, key, bpm, tags (kommagetrennt), type
//   Ablauf: validieren -> scannen (master-player /analyze) ->
//           Audio in Cloudflare R2 -> Metadaten in Supabase.
// ===========================================================================
const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 100);
const UPLOAD_KINDS = new Set(['sample', 'recording', 'stem', 'sound', 'voice']);
const AUDIO_EXT_RE = /\.(wav|mp3|flac|ogg|m4a|aac|aiff|aif)$/i;

export function registerUploadRoutes(app: Express, deps: UploadDeps): void {
  const { getMasterPlayerUrl, parseMultipartStream } = deps;
  app.post('/api/upload/sample', async (req, res) => {
    if (!req.is('multipart/form-data')) {
      return res.status(415).json({ status: 'error', message: 'Erwartet multipart/form-data mit Feld "file".' });
    }
    try {
      // P-2/P-8: Streaming-Parser mit Limit – bricht zu große Uploads WÄHREND
      // des Lesens ab, statt erst nach Buffer.concat zu prüfen.
      const { fields, files } = await parseMultipartStream(req, UPLOAD_MAX_MB * 1024 * 1024);
      const file = files[0];
      if (!file) return res.status(400).json({ status: 'error', message: 'Kein Datei-Feld "file" gefunden.' });

      // --- Validierung ---
      const ext = (file.filename.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase();
      if (!AUDIO_EXT_RE.test(file.filename) && !(file.contentType || '').startsWith('audio/')) {
        return res.status(415).json({ status: 'error', message: `Nicht unterstütztes Audio-Format (.${ext || '?'}). Erlaubt: wav/mp3/flac/ogg/m4a/aac/aiff.` });
      }
      if (file.data.length > UPLOAD_MAX_MB * 1024 * 1024) {
        return res.status(413).json({ status: 'error', message: `Upload zu groß (max. ${UPLOAD_MAX_MB} MB).` });
      }

      const kind = UPLOAD_KINDS.has(fields.kind) ? fields.kind : 'sample';
      const name = (fields.name || file.filename.replace(/\.[^.]+$/, '')).trim() || 'Upload';
      const tags = (fields.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      const bpm = Number(fields.bpm);
      const style = (fields.style || '').trim();
      const artist = (fields.artist || '').trim();
      const key = (fields.key || '').trim();
      const type = (fields.type || kind).trim();

      // --- Scan (best effort über master-player, fällt bei Ausfall weich aus) ---
      let scan: any = null;
      try {
        const scanResp = await fetch(getMasterPlayerUrl() + '/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: file.data.toString('base64') }),
        });
        if (scanResp.ok) scan = await scanResp.json();
      } catch { /* master-player optional */ }

      // --- Ablage: Audio nach R2, Metadaten nach Supabase ---
      const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'audio';
      const objectKey = `uploads/${kind}s/${Date.now()}-${safeName}.${ext || 'wav'}`;
      const uploaded = await uploadSampleToR2(objectKey, file.data, file.contentType || 'audio/wav');

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
        file_size: file.data.length,
      });

      if (!db.ok) {
        return res.status(502).json({ status: 'error', message: 'Supabase-Ablage fehlgeschlagen: ' + (db.error ?? 'unbekannt'), sample, scan, storage: uploaded });
      }

      return res.json({
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
      });
    } catch (e) {
      return res.status(500).json({ status: 'error', message: 'Upload fehlgeschlagen: ' + ((e as Error).message ?? '') });
    }
  });

}
