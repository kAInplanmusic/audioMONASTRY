/**
 * audioMONASTRY · Cloud-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * =====================================================================
 * Externe Cloud-Anbindung (Supabase + Cloudflare R2):
 *   GET  /api/cloud/health   → Konfiguration/Aufrufstatus (Supabase, R2)
 *   POST /api/cloud/sync     → Seeds die eingebauten Presets in Supabase
 *   POST /api/cloud/samples  → einzelnes Sample in Supabase upserten
 *   POST /api/cloud/music    → einzelnen Musik-Track in Supabase upserten
 *   POST /api/cloud/upload   → Audio-Blob (binär ODER base64-JSON) in R2 legen
 *
 * Bewusst als reine Factory: alle Abhängigkeiten kommen aus den Modulen
 * `../cloud` / `../cloudAutomation`; kein Zugriff auf server.ts-Scope.
 */
import express from 'express';
import type { Express } from 'express';
import {
  cloudHealth,
  pushMusicTrackToCloud,
  pushSampleToCloud,
  syncCloudDatabase,
  uploadSampleToR2,
} from '../cloud';
import { ingestAudioObject, syncR2ToSupabase } from '../cloudAutomation';
import { logR2Once, r2ProblemHint, toR2WriteError } from '../r2Health';
import {
  CloudMusicSchema,
  CloudSampleSchema,
  CloudUploadJsonSchema,
} from '../../src/types/zod/schemas';

export function registerCloudRoutes(app: Express): void {
  // F2: `?probe=1` erzwingt eine frische R2-Schreibprobe (TTL-Cache aus). Das
  // Portal-Ladebild und der Smoke-Test pollen die Route; ohne Cache würde jede
  // Abfrage ein PUT/DELETE in R2 auslösen, ohne Force kann der Betreiber nach
  // einer Credential-Korrektur nicht sofort nachmessen.
  app.get('/api/cloud/health', async (req, res) => {
    try {
      const force = req.query.probe === '1' || req.query.force === '1';
      const health = await cloudHealth({ force });
      res.json(health);
    } catch (e) {
      console.error('[cloud] /api/cloud/health fehlgeschlagen:', e);
      res.status(500).json({ error: 'cloud-health-failed' });
    }
  });

  app.post('/api/cloud/sync', async (_req, res) => {
    try {
      const result = await syncCloudDatabase();
      let r2 = null;
      try {
        r2 = await syncR2ToSupabase();
      } catch (e) {
        console.error('[cloud] syncR2ToSupabase fehlgeschlagen:', e);
        r2 = { total: 0, ok: 0, failed: 0, errors: ['r2-sync-failed'] };
      }
      res.status(result.ok ? 200 : 502).json({ ...result, r2 });
    } catch (e) {
      console.error('[cloud] /api/cloud/sync fehlgeschlagen:', e);
      res.status(500).json({ error: 'cloud-sync-failed' });
    }
  });

  // --- POST /api/cloud/samples → einzelnes Sample in Supabase upserten ---
  app.post('/api/cloud/samples', async (req, res) => {
    try {
      // ARCH-SEC-003: Zod-Runtime-Validierung statt unsicherem Cast.
      const parsed = CloudSampleSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'invalid sample payload', details: parsed.error.issues.slice(0, 5) });
      }
      const sample = parsed.data;
      const result = await pushSampleToCloud({
        id: sample.id,
        name: sample.name,
        category: sample.category,
        type: sample.type,
        url: sample.url,
        description: sample.description ?? '',
        tags: sample.tags ?? [],
        parameters: (sample.parameters ?? {}) as { frequency?: number; decay?: number; pitchDecay?: number; oscillatorType?: string },
      });
      res.status(result.ok ? 200 : 502).json(result);
    } catch (e) {
      console.error('[cloud] /api/cloud/samples fehlgeschlagen:', e);
      res.status(500).json({ ok: false, error: 'cloud-sample-upload-failed' });
    }
  });

  // --- POST /api/cloud/music → einzelnen Musik-Track in Supabase upserten ---
  app.post('/api/cloud/music', async (req, res) => {
    try {
      // ARCH-SEC-003: Zod-Runtime-Validierung statt unsicherem Cast.
      const parsed = CloudMusicSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'invalid track payload', details: parsed.error.issues.slice(0, 5) });
      }
      const track = parsed.data;
      const result = await pushMusicTrackToCloud({
        id: track.id,
        name: track.name,
        artist: track.artist ?? 'Unknown',
        url: track.url,
        bpm: track.bpm,
      });
      res.status(result.ok ? 200 : 502).json(result);
    } catch (e) {
      console.error('[cloud] /api/cloud/music fehlgeschlagen:', e);
      res.status(500).json({ ok: false, error: 'cloud-music-upload-failed' });
    }
  });

  // --- POST /api/cloud/upload → Audio-Blob (binär ODER base64-JSON) in R2 legen ---
  // Binär (empfohlen):  POST /api/cloud/upload?key=…&contentType=audio/wav
  //   Body = rohe Bytes, Content-Type: application/octet-stream.
  // Legacy-JSON:        Body = { key, dataBase64, contentType } (bleibt kompatibel).
  app.post('/api/cloud/upload', express.raw({ type: ['application/octet-stream', 'audio/*', 'application/wav'], limit: '200mb' }), async (req, res) => {
    try {
      let key = String(req.query.key ?? '');
      let contentType = String(req.query.contentType ?? 'audio/wav');
      let buf: Buffer | null = null;

      if (Buffer.isBuffer(req.body)) {
        buf = req.body;
      } else {
        // ARCH-SEC-003: Zod-Runtime-Validierung statt unsicherem Cast.
        const parsed = CloudUploadJsonSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ ok: false, error: 'upload requires key + binary body (?key=…) or JSON { key, dataBase64 }', details: parsed.error.issues.slice(0, 5) });
        }
        key = parsed.data.key;
        contentType = parsed.data.contentType ?? contentType;
        buf = Buffer.from(parsed.data.dataBase64, 'base64');
      }

      if (!key) return res.status(400).json({ ok: false, error: 'upload requires key' });
      // P-12: Strikte Key-Whitelist (nur uploads/<name>, keine Sonderzeichen-Pfade).
      if (!/^uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(key)) {
        return res.status(400).json({ ok: false, error: 'invalid key (nur uploads/<dateiname> erlaubt)' });
      }
      if (!buf || buf.byteLength === 0) return res.status(400).json({ ok: false, error: 'upload requires non-empty body' });

      const result = await uploadSampleToR2(key, buf, contentType);
      // Automation: neues Audio direkt analysieren + in Supabase ablegen.
      const ingest = await ingestAudioObject(key, buf.byteLength);
      res.json({ ok: true, ...result, ingest });
    } catch (e) {
      // F2: Der Fehler wird klassifiziert statt als roher SDK-Text in einem 500
      // zu landen (live: `POST /api/upload/sample` → HTTP 500 exakt mit
      // „SignatureDoesNotMatch“). Konfigurationsfehler sind 503 (Client kann
      // lokal weiterarbeiten), echte Schreibfehler 502 mit sichtbarem Grund.
      const writeError = toR2WriteError(e);
      const status = writeError.problem === 'not-configured' || writeError.problem === 'bucket-missing' ? 503 : 502;
      if (status === 503) {
        logR2Once('upload:not-configured', `[cloud] /api/cloud/upload ohne R2-Konfiguration: ${writeError.message}`, 'warn');
      } else {
        logR2Once(`upload:${writeError.problem}`, `[cloud] /api/cloud/upload fehlgeschlagen [${writeError.problem}]: ${writeError.message}. ${r2ProblemHint(writeError.problem)}`);
      }
      res.status(status).json({
        ok: false,
        error: status === 503 ? 'r2-not-configured' : 'cloud-upload-failed',
        reason: writeError.problem,
        degraded: true,
        hint: r2ProblemHint(writeError.problem),
      });
    }
  });
}
