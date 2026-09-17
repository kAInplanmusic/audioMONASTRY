/**
 * audioMONASTRY · Media-/Info-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * ========================================================================
 * Vier Endpunkte ohne gemeinsamen Zustand, aber ohne Grund, in server.ts zu liegen:
 *   POST /api/generate-voice  → lokale Voice-Erzeugung (execFile), faellt ohne
 *                               lokale Runtime auf Web-Speech zurueck
 *   GET  /api/library         → Sample-/Loop-Bibliothek
 *   GET  /api/stem/status     → Stem-Provider-Status (oeffentlich, ohne Secrets)
 *   GET  /api/webrtc-config   → ICE-Konfiguration fuer die Clients
 * 
 * Bewusst als Factory ohne Dependency-Objekt: das Werkzeug weist fuer diese vier
 * Gruppen ausser `app` nichts Geteiltes aus
 * (scripts/route-dependency-graph.py --plan /api/generate-voice,/api/library,/api/stem,/api/webrtc-config).
 * Der Code wurde 1:1 verschoben; die Einrueckung ist die einzige Aenderung.
 */
import { supabaseServerKey, supabaseUrl } from '../../src/config/supabaseKeys';
import { aiPersistence } from '../../src/core/ai/orchestrator/aiPersistence';
import { embedText } from '../../src/core/ai/orchestrator/textEmbedding';
import { orchestralSamples } from '../../src/data/orchestralLibrary';
import { PRESET_SAMPLE_DATABASE } from '../../src/data/samples';
import { GenerateVoiceSchema, LibrarySearchSchema } from '../../src/types/zod/schemas';
import { buildWebRtcConfigResponse } from '../webrtcConfig.ts';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import express, { type Express } from 'express';
import {
  AUDIO_EXPORT_FORMATS,
  AudioEncodeError,
  encodeAudioBuffer,
  exportFileName,
  exportFormatInfo,
  sanitizeMetadataValue,
} from '../audioEncode.ts';


export function registerMediaRoutes(app: Express): void {
  // COLLAB-P0-003: autoritative ICE/TURN-Konfiguration. Token-frei wie /api/health
  // (nur ICE-Server, keine App-Daten); das TURN-Secret bleibt serverseitig, der
  // Client bekommt pro Anfrage kurzlebige coturn-REST-Credentials.
  app.get('/api/webrtc-config', (req, res) => {
    try {
      const userId = String((req.query as { userId?: string }).userId ?? '').slice(0, 64);
      res.setHeader('Cache-Control', 'no-store');
      res.json(buildWebRtcConfigResponse(process.env, { userId, now: Date.now() }));
    } catch (e) {
      console.warn('[webrtc-config] Aufbau fehlgeschlagen:', (e as Error).message);
      res.status(500).json({ error: 'webrtc-config unavailable' });
    }
  });

  // --- POST /api/audio/encode → Codec-Export für Mixdown/Master (FEAT-P3-004) ---
  // Body: WAV binaer (Content-Type audio/* oder application/octet-stream).
  // Query: ?format=wav|mp3|flac|aac|ogg, optional &title=&artist=&album=&comment=&name=
  // Antwort: kodierte Datei als Download (Content-Type + Content-Disposition).
  app.post(
    '/api/audio/encode',
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '50mb' }),
    async (req, res) => {
      const format = exportFormatInfo(req.query.format);
      if (!format) {
        return res.status(400).json({
          error: 'unknown format',
          formats: AUDIO_EXPORT_FORMATS.map((f) => f.format),
        });
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const query = req.query as Record<string, unknown>;
      try {
        const { data, info } = await encodeAudioBuffer(body, format.format, {
          title: sanitizeMetadataValue(query.title),
          artist: sanitizeMetadataValue(query.artist),
          album: sanitizeMetadataValue(query.album),
          comment: sanitizeMetadataValue(query.comment),
        });
        res.setHeader('Content-Type', info.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(info, String(query.name ?? ''))}"`);
        res.setHeader('X-Audio-Format', info.format);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(data);
      } catch (error) {
        const code = error instanceof AudioEncodeError ? error.code : 'ENCODE_FAILED';
        const status = code === 'UNKNOWN_FORMAT' || code === 'EMPTY_INPUT' ? 400 : code === 'NO_FFMPEG' ? 503 : 500;
        console.warn('[audio-encode] fehlgeschlagen:', code, (error as Error).message);
        return res.status(status).json({ error: code, message: (error as Error).message });
      }
    },
  );

  // --- POST /api/library/search → semantische Bibliotheks-Suche (NEW-MONK-6) ---
  // 1) Supabase-Embedding-Pfad: match_samples-RPC (pgvector, Kosinus) – sobald
  //    Supabase konfiguriert ist (Migration 005). 2) Lokaler Keyword-Fallback.
  app.post('/api/library/search', async (req, res) => {
    const parsedSearch = LibrarySearchSchema.safeParse(req.body ?? {});
    if (!parsedSearch.success) {
      return res.status(400).json({ error: parsedSearch.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { query, limit } = parsedSearch.data;
    const q = String(query ?? '').trim().slice(0, 200);
    if (!q) return res.status(400).json({ error: 'query fehlt' });
    const max = Math.max(1, Math.min(50, Number(limit) || 10));

    // RPC-Pfad (nur wenn Supabase konfiguriert ist; sonst lokaler Embedding-Pfad).
    // Wichtig: die Formatprüfung nutzen — vorher galt „konfiguriert" auch mit einem
    // abgelaufenen Legacy-PAT, wodurch der RPC-Pfad still ins Leere lief.
    const supabaseConfigured = Boolean(supabaseUrl() && supabaseServerKey());
    if (supabaseConfigured) {
      const matches = await aiPersistence.rpcMatchSamples(embedText(q), max);
      if (matches.length > 0) {
        const byId = new Map(PRESET_SAMPLE_DATABASE.map((s) => [s.id, s]));
        const results = matches.map((m) => ({
          id: m.sample_id,
          name: byId.get(m.sample_id)?.name ?? m.sample_id,
          category: byId.get(m.sample_id)?.category ?? 'mids',
          score: Number(m.similarity.toFixed(4)),
        }));
        return res.json({ query: q, results, provider: 'supabase-embeddings' });
      }
    }

    // Lokaler semantischer Pfad: Kosinus-Ähnlichkeit über deterministische
    // Embeddings (funktioniert komplett ohne Supabase-DDL).
    const queryVec = embedText(q);
    const samples = [...PRESET_SAMPLE_DATABASE, ...orchestralSamples()];
    const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    const semantic = samples
      .map((s) => {
        const vec = embedText(`${s.name} ${s.description}`);
        return { sample: s, score: dot(queryVec, vec) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, max);

    // Fallback auf Keyword-Scoring, falls keine sinnvolle Ähnlichkeit gefunden.
    if (semantic.length > 0 && semantic[0].score >= 0.15) {
      return res.json({
        query: q,
        results: semantic.map((r) => ({
          id: r.sample.id,
          name: r.sample.name,
          category: r.sample.category,
          score: Number(r.score.toFixed(4)),
        })),
        provider: 'local-embeddings',
      });
    }

    const qLower = q.toLowerCase();
    const results = PRESET_SAMPLE_DATABASE
      .map((s) => {
        const name = s.name.toLowerCase();
        const category = s.category.toLowerCase();
        const tokens = qLower.split(/\s+/).filter(Boolean);
        let score = 0;
        for (const t of tokens) {
          if (name === t) score += 8;
          else if (name.includes(t)) score += 4;
          else if (category.includes(t)) score += 2;
          else if (name.includes(t[0] ?? '')) score += 1;
        }
        if (tokens.length === 0) score = 1;
        return { sample: s, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.sample.name.localeCompare(b.sample.name))
      .slice(0, max)
      .map((r) => ({ id: r.sample.id, name: r.sample.name, category: r.sample.category, score: r.score }));
    return res.json({ query: q, results, provider: 'keyword-fallback' });
  });

  // --- Stem-Provider-Status (öffentlich, ohne Secrets) --------------------------
  app.get('/api/stem/status', (_req, res) => {
    const provider = (process.env.STEM_AI_PROVIDER || 'fallback').trim();
    const replicateActive = provider === 'replicate' && Boolean((process.env.REPLICATE_API_TOKEN || '').trim());
    res.json({
      provider: replicateActive ? 'replicate' : provider,
      replicateActive,
      estimateUsdPerSong: 0.05, // ehrliche Schätzung inkl. Kaltstart-Overhead (Stand 2026)
    });
  });

  // --- POST /api/generate-voice  → lokaler Voice-Stub ---
  app.post('/api/generate-voice', async (req, res) => {
    const parsedVoice = GenerateVoiceSchema.safeParse(req.body ?? {});
    if (!parsedVoice.success) {
      return res.status(400).json({ error: parsedVoice.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { text, voicePreset } = parsedVoice.data;
    // S6350: Eingabe sanitieren, bevor sie als CLI-Argument verwendet wird.
    const query = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
    const rawPreset = String(voicePreset ?? 'FEMALE_ROBOTIC').trim();
    const preset = /^[A-Za-z0-9_-]{1,32}$/.test(rawPreset) ? rawPreset : 'FEMALE_ROBOTIC';

    // Falls ein lokaler RVC/VITS-Synthesizer per env aktiviert ist und das CLI
    // existiert, wird dieser bevorzugt. Konfiguration:
    //   VOICE_ENGINE=rvc|vits   VOICE_CLI=/pfad/zu/predict (optional)
    const engine = (process.env.VOICE_ENGINE || '').trim().toLowerCase();
    const voiceCli = (process.env.VOICE_CLI || '').trim();
    // S-6: Nur absolute Pfade in einer kleinen Allowlist (kein beliebiger env-Pfad).
    const VOICE_CLI_ALLOWED = ['/usr/local/bin/predict', '/opt/rvc/predict', '/opt/voice-cli/predict'];
    const voiceCliAllowed = VOICE_CLI_ALLOWED.includes(voiceCli)
      || (voiceCli.startsWith('/') && !voiceCli.includes('..') && /^[\x20-\x7E]+$/.test(voiceCli) && voiceCli.includes('/'));
    if (engine && voiceCli && voiceCliAllowed && query) {
      try {
        const audioUrl = await new Promise<string>((resolve, reject) => {
          const stamp = `${Date.now()}-${randomBytes(4).toString('hex')}`;
          const outFile = `dist/voices/voice_${stamp}.wav`;
          const args = ['--input', query, '--output', outFile, '--preset', preset];
          execFile(voiceCli, args, { timeout: 45000 }, (err: Error | null) => {
            if (err) return reject(err);
            resolve(`/voices/voice_${stamp}.wav`);
          });
        });
        return res.json({ status: 'ok', url: audioUrl, text: query, voicePreset: preset });
      } catch (e) {
        console.warn('[voice] lokaler Engine-Fehler, Fallback auf Web-Speech.', (e as Error).message);
      }
    }

    // Kein lokaler Engine-CLI: hinterlasse status 'local', das Frontend nutzt dann
    // Web-Speech-Synthese (kein Cloud-TTS, keine Server-Cloudabhängigkeit).
    return res.json({
      status: 'local',
      url: '',
      text: query,
      voicePreset: preset,
      hint: 'Web-Speech (browser) verwenden',
    });
  });

}
