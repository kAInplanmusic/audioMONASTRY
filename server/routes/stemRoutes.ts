/**
 * audioMONASTRY · Stem-Separation (ARCH-P2-002, Extraktion aus server.ts)
 * =====================================================================
 *   POST /api/separate-stems  (multipart/form-data, Feld: file)
 *     Ablauf: Multipart einlesen -> Backpressure-Pruefung (STEM_MAX_JOBS) ->
 *             Stem-Job an die AI-Runtime (getStemAiUrl) -> Ergebnis zurueck.
 * 
 * Dieses Modul BESITZT den Stem-Job-Zustand: stemActiveJobs und stemJobSeq werden
 * hier gefuehrt, weil diese Route sie schreibt. Andere Module (Ops-Metriken,
 * Admin-Status) lesen sie ueber den exportierten Getter getStemActiveJobs() - eine
 * Wertkopie wuerde einfrieren.
 * 
 * Gereicht werden: STEM_MAX_JOBS (Backpressure-Grenze), metrics (Zaehler in
 * server.ts), parseMultipartStream (auch /api/upload nutzt ihn) und fleetTargets.
 * 
 * Der Code wurde 1:1 verschoben; die Einrueckung ist die einzige Aenderung.
 */
import type { Express } from 'express';

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
}

let stemActiveJobs = 0;
let stemJobSeq = 0;

/** Lebend-Zugriff: diese Route schreibt den Zaehler, andere lesen ihn. */
export const getStemActiveJobs = () => stemActiveJobs;

export function registerStemRoutes(app: Express, deps: StemDeps): void {
  const { STEM_MAX_JOBS, fleetTargets, metrics, parseMultipartStream } = deps;

  const STEM_JOB_TIMEOUT_MS = Math.max(10_000, Number(process.env.STEM_JOB_TIMEOUT_MS ?? 300_000));

  const stemJobStatus = new Map<string, 'active' | 'pending' | 'success' | 'failed' | 'cancelled' | 'timeout'>();

  // --- POST /api/separate-stems  → lokaler Stems-Stub (SSE mit Fortschritt) ---
  // P11: Proxy zum separaten stem-ai (FastAPI/Demucs) Container, falls aktiviert.
  const getStemAiUrl = () => (process.env.STEM_AI_URL || '').trim() || fleetTargets.stemAi || 'http://stem-ai:8000'; // NOSONAR: interner Docker-Netzwerk-Endpunkt ohne TLS

  const STEM_MAX_UPLOAD_MB = Number(process.env.STEM_MAX_UPLOAD_MB || 100);

  app.post('/api/separate-stems', async (req, res) => { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
    metrics.stemRequests += 1;
    // Runtime-Check (nicht nur Modul-Konstante), damit Tests/Deploys den Pfad
    // per Env togglen können und die Queue-Logik deterministisch greifbar ist.
    const stemAiActive = (process.env.ENABLE_STEMS || '').trim() === '1' && !!(process.env.STEM_AI_URL || fleetTargets.stemAi);
    const replicateStemsActive = (process.env.STEM_AI_PROVIDER || '').trim() === 'replicate'
      && !!(process.env.REPLICATE_API_TOKEN || '').trim();

    // Pay-per-Use GPU-Stems über Replicate (Serverless, ~3–5 Cent/Song).
    if (replicateStemsActive && req.is('multipart/form-data')) {
      try {
        const { files } = await parseMultipartStream(req, STEM_MAX_UPLOAD_MB * 1024 * 1024);
        if (files.length === 0) { res.status(400).json({ error: 'keine Audiodatei' }); return; }
        const file = files[0];
        const dataUri = `data:${file.contentType || 'audio/wav'};base64,${file.data.toString('base64')}`;
        const token = (process.env.REPLICATE_API_TOKEN || '').trim();
        const model = (process.env.REPLICATE_STEM_MODEL || 'cjwbw/demucs').trim();

        // Version explizit auflösen: der Modell-Alias kann 404 liefern, obwohl
        // die Version lauffähig ist. Danach Prediction auf der Version starten.
        const modelResp = await fetch(`https://api.replicate.com/v1/models/${model}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!modelResp.ok) { res.status(modelResp.status).json({ error: `Replicate model ${modelResp.status}` }); return; }
        const modelInfo = await modelResp.json() as any;
        const versionId: string = modelInfo?.latest_version?.id ?? '';
        if (!versionId) { res.status(404).json({ error: 'Replicate: keine lauffähige Version' }); return; }

        const createResp = await fetch(`https://api.replicate.com/v1/models/${model}/versions/${versionId}/predictions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait' },
          body: JSON.stringify({ input: { audio: dataUri } }),
          signal: AbortSignal.timeout(180_000),
        });
        if (createResp.status === 402) {
          // Kein Guthaben mehr → Client soll auf lokal zurückfallen (Dropdown-Logik).
          res.status(402).json({ status: 'error', code: 'INSUFFICIENT_CREDIT', provider: 'replicate', message: 'Replicate-Guthaben aufgebraucht – lokale Extraktion nutzen.' });
          return;
        }
        if (!createResp.ok) { res.status(createResp.status).json({ error: `Replicate ${createResp.status}` }); return; }
        const prediction = await createResp.json() as any;
        const status = prediction?.status;
        if (status === 'succeeded') {
          res.json({ status: 'success', provider: 'replicate', stems: prediction.output ?? {} });
        } else if (status === 'failed') {
          res.status(502).json({ status: 'error', message: 'Replicate-Stem-Job fehlgeschlagen' });
        } else {
          // Polling-Fallback, falls Prefer: wait nicht durchlief.
          let current: any = prediction;
          for (let i = 0; i < 30 && current?.status !== 'succeeded' && current?.status !== 'failed'; i++) {
            await new Promise((r) => setTimeout(r, 4000));
            const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(30_000),
            });
            current = await pollResp.json();
          }
          if (current?.status === 'succeeded') res.json({ status: 'success', provider: 'replicate', stems: current.output ?? {} });
          else res.status(502).json({ status: 'error', message: 'Replicate-Stem-Job fehlgeschlagen' });
        }
      } catch (e) {
        metrics.stemFailures += 1;
        res.status(502).json({ status: 'error', message: 'Replicate-Stems fehlgeschlagen: ' + ((e as Error).message ?? '') });
      }
      return;
    }

    // FormData-Upload (Vite-Frontend/streamStems sendet multipart) -> stem-ai.
    if (stemAiActive && req.is('multipart/form-data')) {
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

      try {
        // P-2/P-8: Streaming-Parser mit Limit (kein unbegrenztes RAM-Puffern).
        const { fields, files } = await parseMultipartStream(req, STEM_MAX_UPLOAD_MB * 1024 * 1024);
        const fd = new FormData();
        for (const f of files) {
          fd.append(f.name, new Blob([f.data], { type: f.contentType }), f.filename);
        }
        for (const [name, value] of Object.entries(fields)) {
          fd.append(name, value);
        }

        const resp = await fetch(getStemAiUrl() + '/separate-stems', {
          method: 'POST',
          body: fd,
          signal: AbortSignal.timeout(STEM_JOB_TIMEOUT_MS),
        });
        const data = await resp.json() as any;
        if (idempotencyKey) stemJobStatus.set(idempotencyKey, resp.ok ? 'success' : 'failed');
        res.status(resp.status).json({ ...data, provider: 'stem-ai' });
        return;
      } catch (e) {
        metrics.stemFailures += 1;
        if (idempotencyKey) stemJobStatus.set(idempotencyKey, 'timeout');
        res.status(502).json({ status: 'error', message: 'stem-ai Proxy fehlgeschlagen: ' + ((e as Error).message ?? '') });
        return;
      } finally {
        stemActiveJobs = Math.max(0, stemActiveJobs - 1);
        // P-14-Fix: Idempotency-Key sofort nach Abschluss freigeben – die Sperre
        // gilt nur für den aktiven Job. Legitime Retries (auch nach Fehlschlag)
        // sind damit sofort wieder möglich.
        if (idempotencyKey) {
          stemJobStatus.delete(idempotencyKey);
        }
        void jobId;
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Fallback: simulierte 4-Stem-Aufteilung (Stub) mit Fortschritt
    let p = 0;
    const timer = setInterval(() => {
      p += 20;
      res.write(`data: ${JSON.stringify({ progress: p })}\n\n`);
      if (p >= 100) {
        clearInterval(timer);
        res.write(`data: ${JSON.stringify({
        status: 'success',
        provider: 'fallback',
        stems: {
          vocals: '', melody: '', highs: '', mids: '', lows: '',
        },
      })}\n\n`);
        res.end();
      }
    }, 300);
  });
}
