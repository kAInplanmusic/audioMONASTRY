/**
 * audioMONASTRY · Stem-Separation (ARCH-P2-002, Extraktion aus server.ts)
 * =====================================================================
 *   POST /api/separate-stems  (multipart/form-data, Feld: file)
 *     Felder (optional): mode = auto | 5stem | 4stem,
 *                        targetBpm, targetKey, sourceBpm, sourceKey, warp=0
 *
 * FLEET-P1-006 – Wege (kein stiller Schein-Fallback):
 *   5stem  RP5 (stems-Pod) mit bs-roformer-sw-6stem, 5 Stems per Weiche,
 *          optional BPM/Key-Warp auf das Projekt. Fehlt der Pod oder sind die
 *          Gewichte nicht ladbar: klare Fehlermeldung (503) – KEIN Rueckfall.
 *   4stem  stem-ai (htdemucs): ehrlich 4 Stems (Gesang/Bass/Drums/Rest), als
 *          4-Stem-Modus gekennzeichnet. Nur auf Wunsch bzw. in `auto`, wenn
 *          RP5 gar nicht konfiguriert ist (Hinweis `fallbackReason`).
 *   auto   (Standard) RP5, wenn konfiguriert – sonst 4stem, wenn stem-ai aktiv.
 *
 * Antwort: JSON mit URLs (R2 oder Server-Ablage), nie Base64. Die Stems stehen
 * danach in der Bibliothek (`library`, serverseitig eingetragen).
 *
 * Dieses Modul BESITZT den Stem-Job-Zustand: stemActiveJobs und stemJobSeq werden
 * hier gefuehrt, weil diese Route sie schreibt. Andere Module (Ops-Metriken,
 * Admin-Status) lesen sie ueber den exportierten Getter getStemActiveJobs() - eine
 * Wertkopie wuerde einfrieren.
 *
 * Gereicht werden: STEM_MAX_JOBS (Backpressure-Grenze), metrics (Zaehler in
 * server.ts), parseMultipartStream (auch /api/upload nutzt ihn) und fleetTargets.
 * Optional (Tests): rp5Available, runStemTask, storage, writeLibrary.
 */
import type { Express, Response } from 'express';
import {
  classifyStemFailure,
  ingestFourStems,
  parseWarpFields,
  rp5StemAvailable,
  RP5_STEM_MODEL,
  runStemTaskOnFleet,
  separateOnRp5,
  StemRequestError,
  type LibraryWriter,
  type RunStemTask,
  type StemStorage,
} from '../stemSeparation.ts';

/** Zaehler, die server.ts besitzt und die hier fortgeschrieben werden. */
export interface StemMetrics {
  stemRequests: number;
  stemFailures: number;
}
/** Von server.ts gereichte Abhaengigkeiten (siehe Modul-Kommentar). */
export interface StemDeps {
  STEM_MAX_JOBS: number;
  fleetTargets: { stemAi?: string };
  metrics: StemMetrics;
  parseMultipartStream: (req: import('http').IncomingMessage, maxFileBytes: number) => Promise<{ fields: Record<string, string>; files: { name: string; filename: string; contentType: string; data: Buffer }[] }>;
  rp5Available?: () => boolean;
  runStemTask?: RunStemTask;
  storage?: StemStorage;
  writeLibrary?: LibraryWriter;
}

let stemActiveJobs = 0;
let stemJobSeq = 0;

/** Lebend-Zugriff: diese Route schreibt den Zaehler, andere lesen ihn. */
export const getStemActiveJobs = () => stemActiveJobs;

type StemMode = 'auto' | '5stem' | '4stem';

function parseMode(raw: string | undefined): StemMode | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v === 'auto') return 'auto';
  if (v === '5stem' || v === 'rp5') return '5stem';
  if (v === '4stem' || v === 'stem-ai') return '4stem';
  return null;
}

export function registerStemRoutes(app: Express, deps: StemDeps): void {
  const { STEM_MAX_JOBS, fleetTargets, metrics, parseMultipartStream } = deps;
  const rp5Available = deps.rp5Available ?? rp5StemAvailable;
  const runStemTask = deps.runStemTask ?? runStemTaskOnFleet;

  const STEM_JOB_TIMEOUT_MS = Math.max(10_000, Number(process.env.STEM_JOB_TIMEOUT_MS ?? 300_000));

  const stemJobStatus = new Map<string, 'active' | 'pending' | 'success' | 'failed' | 'cancelled' | 'timeout'>();

  // P11: separater stem-ai (FastAPI/Demucs) Container – nur noch der 4-Stem-Modus.
  const getStemAiUrl = () => (process.env.STEM_AI_URL || '').trim() || fleetTargets.stemAi || 'http://stem-ai:8000'; // NOSONAR: interner Docker-Netzwerk-Endpunkt ohne TLS
  const stemAiActive = () => (process.env.ENABLE_STEMS || '').trim() === '1' && !!(process.env.STEM_AI_URL || fleetTargets.stemAi);

  const STEM_MAX_UPLOAD_MB = Number(process.env.STEM_MAX_UPLOAD_MB || 100);

  const fail = (res: Response, status: number, body: Record<string, unknown>) => {
    metrics.stemFailures += 1;
    return res.status(status).json({ status: 'error', ...body });
  };

  app.post('/api/separate-stems', async (req, res) => { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
    metrics.stemRequests += 1;
    if (!req.is('multipart/form-data')) {
      res.status(400).json({ error: 'Erwartet multipart/form-data mit Feld "file".' });
      return;
    }

    // Runtime-Check (nicht nur Modul-Konstante), damit Tests/Deploys den Pfad
    // per Env togglen können und die Queue-Logik deterministisch greifbar ist.
    const rp5 = rp5Available();
    const stemAi = stemAiActive();

    if (rp5 || stemAi) {
      // DCT-101: Backpressure – harte Job-Grenze, Idempotency + Timeout-Reset.
      if (stemActiveJobs >= STEM_MAX_JOBS) {
        metrics.stemFailures += 1;
        res.setHeader('Retry-After', '30');
        return res.status(429).json({
          error: 'STEM_QUEUE_FULL',
          code: 'STEM_QUEUE_FULL',
          retryAfter: 30,
          queuePosition: stemActiveJobs - STEM_MAX_JOBS + 1,
        });
      }

      const idempotencyKey = (req.headers['x-idempotency-key'] as string | undefined)?.trim() || null;
      if (idempotencyKey && stemJobStatus.has(idempotencyKey)) {
        return res.status(409).json({ error: 'DUPLICATE_REQUEST', code: 'DUPLICATE_REQUEST', idempotencyKey });
      }

      const jobId = `stem-${Date.now().toString(36)}-${(++stemJobSeq).toString(36)}`;
      if (idempotencyKey) stemJobStatus.set(idempotencyKey, 'active');
      stemActiveJobs += 1;
      // Abbruch im Client (Cancel/Verbindung weg) bricht auch den Flotten-Auftrag ab.
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) abort.abort(); });

      try {
        // P-2/P-8: Streaming-Parser mit Limit (kein unbegrenztes RAM-Puffern).
        const { fields, files } = await parseMultipartStream(req, STEM_MAX_UPLOAD_MB * 1024 * 1024);
        const file = files.find((f) => f.name === 'file') ?? files[0];
        if (!file || file.data.length === 0) return fail(res, 400, { code: 'STEM_NO_FILE', message: 'Feld "file" fehlt oder ist leer.' });
        const mode = parseMode(fields.mode);
        if (!mode) return fail(res, 400, { code: 'STEM_INVALID_REQUEST', message: 'mode muss auto, 5stem oder 4stem sein.' });

        const useRp5 = mode === '5stem' || (mode === 'auto' && rp5);
        if (useRp5) {
          if (!rp5) {
            const f = classifyStemFailure(Object.assign(new Error('kein Provider für stem.separate (RP5/voiceGen nicht konfiguriert)'), { code: 'NO_PROVIDER' }), RP5_STEM_MODEL);
            if (idempotencyKey) stemJobStatus.set(idempotencyKey, 'failed');
            return fail(res, f.httpStatus, { code: f.code, message: f.message, hint: f.hint, fourStemAvailable: stemAi });
          }
          try {
            const warp = parseWarpFields(fields);
            const result = await separateOnRp5(
              { data: file.data, filename: file.filename || 'audio.wav' },
              { model: RP5_STEM_MODEL, warp, signal: abort.signal },
              { runTask: runStemTask, storage: deps.storage, writeLibrary: deps.writeLibrary },
            );
            if (idempotencyKey) stemJobStatus.set(idempotencyKey, 'success');
            return res.json({ ...result, jobId });
          } catch (e) {
            if (idempotencyKey) stemJobStatus.set(idempotencyKey, 'failed');
            const f = classifyStemFailure(e, RP5_STEM_MODEL);
            console.warn(`[stems] RP5 ${jobId}: ${f.code} – ${(e as Error).message}`);
            return fail(res, f.httpStatus, { code: f.code, message: f.message, hint: f.hint, fourStemAvailable: stemAi });
          }
        }

        // 4-Stem-Modus (stem-ai). In `auto` nur, weil RP5 nicht konfiguriert ist.
        if (!stemAi) {
          return fail(res, 503, { code: 'NO_STEM_PROVIDER', message: '4-Stem-Modus (stem-ai) ist nicht aktiv (ENABLE_STEMS=1, STEM_AI_URL).' });
        }
        const fd = new FormData();
        fd.append('file', new Blob([new Uint8Array(file.data)], { type: file.contentType }), file.filename);
        const base = getStemAiUrl();
        const resp = await fetch(base + '/separate-stems', {
          method: 'POST',
          body: fd,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(STEM_JOB_TIMEOUT_MS)]),
        });
        const data = await resp.json() as { status?: string; stems?: Record<string, string>; model?: string; error?: string };
        if (!resp.ok || data.status !== 'success') {
          if (idempotencyKey) stemJobStatus.set(idempotencyKey, 'failed');
          return fail(res, resp.ok ? 502 : resp.status, { code: 'STEM_AI_FAILED', message: `stem-ai: ${data.error ?? `HTTP ${resp.status}`}`, provider: 'stem-ai' });
        }
        const result = await ingestFourStems(base, data, file.filename || 'audio.wav', {
          storage: deps.storage, writeLibrary: deps.writeLibrary, signal: abort.signal,
        });
        if (idempotencyKey) stemJobStatus.set(idempotencyKey, 'success');
        return res.json({
          ...result,
          jobId,
          ...(mode === 'auto' ? { fallbackReason: 'RP5 (stems-Pod) ist nicht konfiguriert – 4-Stem-Modus.' } : {}),
        });
      } catch (e) {
        if (idempotencyKey) stemJobStatus.set(idempotencyKey, 'timeout');
        if (e instanceof StemRequestError) return fail(res, 400, { code: e.code, message: e.message });
        return fail(res, 502, { code: 'STEM_PROXY_FAILED', message: 'stem-ai Proxy fehlgeschlagen: ' + ((e as Error).message ?? '') });
      } finally {
        stemActiveJobs = Math.max(0, stemActiveJobs - 1);
        // P-14-Fix: Idempotency-Key sofort nach Abschluss freigeben – die Sperre
        // gilt nur für den aktiven Job. Legitime Retries (auch nach Fehlschlag)
        // sind damit sofort wieder möglich.
        if (idempotencyKey) {
          stemJobStatus.delete(idempotencyKey);
        }
      }
    }

    // PROD-P1-001: Der simulierte Fallback darf nie stillschweigend als echtes
    // Ergebnis erscheinen. Ohne expliziten fallback-Provider -> 503 (kein
    // Fake-Erfolg); der Stub selbst markiert jede Antwort mit simulated: true.
    if ((process.env.STEM_AI_PROVIDER || '').trim() !== 'fallback') {
      res.status(503).json({
        status: 'error',
        code: 'NO_STEM_PROVIDER',
        message: 'Kein Stem-Provider konfiguriert: RP5 (stems-Pod, AI_FLEET_MODE=pods + RP_POD_ID_STEMS) oder 4-Stem-Modus (ENABLE_STEMS=1).',
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Fallback: simulierte Aufteilung (Stub) mit Fortschritt – ohne Audio.
    let p = 0;
    const timer = setInterval(() => {
      p += 20;
      res.write(`data: ${JSON.stringify({ progress: p })}\n\n`);
      if (p >= 100) {
        clearInterval(timer);
        res.write(`data: ${JSON.stringify({
        status: 'success',
        provider: 'fallback',
        simulated: true,
        stems: {
          vocals: '', melody: '', highs: '', mids: '', lows: '',
        },
      })}\n\n`);
        res.end();
      }
    }, 300);
  });
}
