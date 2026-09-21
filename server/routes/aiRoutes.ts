/**
 * audioMONASTRY · /api/ai-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * ====================================================================
 * Alle Routen unter /api/ai/* inklusive der zugehoerigen Eingangs-Validierung
 * (GAP-4: AI_TASK_IDS/isValidAiTask/isValidModelId - Task muss aus der erlaubten
 * Menge stammen, Modell-IDs werden gegen SSRF/Pfadtraversal gehaertet).
 *
 * Bewusst als Factory mit explizitem Dependency-Objekt: die Routen greifen auf
 * die geteilte `metrics`-Instanz aus server.ts zu (53 Verwendungen dort), die
 * nicht importiert werden kann (Zirkularitaet) und deshalb uebergeben wird.
 *
 * Der Code wurde 1:1 verschoben; die Einrueckung ist die einzige Aenderung.
 */
import {
  AiCompleteSchema,
  AiGenerateDropSchema,
  AiModeRequestSchema,
  AiOrchestrateSchema,
  AiPromptSchema,
  AiShowMergeSchema,
  AiVideoClipSchema,
  AiVideoSchema,
  AiVisionFeedbackSchema,
  AiVisionSchema,
  AiVisionStylesQuerySchema,
  McpToolInvokeSchema,
  MosRatingSchema,
} from '../../src/types/zod/schemas';
import { AiTask } from '../../src/core/ai/orchestrator/types';
import { ClipPipelineError, generateClipFromPrompt } from '../../src/core/ai/vision/clipPipeline';
import {
  DropGenerationRequest,
  DropStyle,
  buildDropPrompt,
  generateDeterministicDrop,
  sanitizeAiDropResponse,
} from '../../src/core/drop/DropTemplateGenerator';
import { IdempotencyConflictError } from '../../src/core/ai/orchestrator/jobManager';
import { MergeError, loadMergeSource, mergeClipBuffers } from '../visionShow.ts';
import { VideoError, generateVideo, stripDataUri } from '../../src/core/ai/vision/runpodVideo';
import { VisionError, generateVisionImage } from '../../src/core/ai/vision/runpodVision';
import { aiOrchestrator } from '../../src/core/ai/orchestrator/aiOrchestrator';
import { aiPersistence } from '../../src/core/ai/orchestrator/aiPersistence';
import { buildVisionPrompt } from '../../src/core/ai/vision/visionPrompt';
import {
  contentTypeForArtifact,
  isSafeArtifactName,
  persistDataUri,
  readArtifact,
  saveArtifact,
} from '../visionArtifacts.ts';
import { fetchVisualStyleRanking, insertVisualFeedback, insertVisualGeneration } from '../cloudAutomation.ts';
import { fleetStatus, sleepFleet, wakeFleet } from '../../src/core/ai/orchestrator/fleetWake';
import { aiGateStatus, getAiOperatingMode, isRoleAllowed, setAiOperatingMode, type AiOperatingMode } from '../../src/core/ai/aiGate';
import { aiLogger } from '../../src/core/ai/orchestrator/aiLogger';
import {
  AI_ESTIMATED_STORAGE_EUR_PER_MONTH,
  AI_HETZNER_EUR_PER_HOUR,
  GPU_ENDPOINT_ROLES,
  fleetBudgetReport,
  isVisualRole,
  type GpuEndpointRole,
} from '../../src/config/aiInfrastructure';
import { llmRouter } from '../../src/core/ai/LlmRouter';
// AI-P2-006: serverseitiger Drop-Cache (VOR dem bezahlten Modellaufruf).
import { dropCache, type DropCache } from '../dropCache.ts';
import { mosHarness } from '../../src/core/ai/orchestrator/mosHarness';
import { resolveVoiceModel } from '../../src/core/ai/orchestrator/voiceModelGate';
import { normalizeStyleRanking, suggestStyleFromRanking } from '../../src/core/ai/vision/visualFeedback';
import { uploadSampleToR2 } from '../cloud.ts';
import type { Express } from 'express';

export interface AiRouteDeps {
  /** Geteilte Metriken aus server.ts (aiRequests/aiFailures + Cache-Treffer). */
  metrics: { aiRequests: number; aiFailures: number; aiCacheHits: number; aiCacheMisses: number };
  /** Geteilte Flotten-Ziele; ollama wird fuer den lokalen Fallback gelesen. */
  fleetTargets: { ollama: string };
  /** Drop-Cache (Tests koennen eine eigene, kuerzere Instanz einhaengen). */
  dropCache?: DropCache;
}

/**
 * INFRA-FEAT-003: Kostenbericht für Status- und Prüf-Antworten.
 *
 * Rechnet die Rollen, die im AKTUELLEN Modus laufen dürfen, gegen das
 * Stundenbudget (inkl. Hetzner-Anteil) und die Speicherkosten gegen das
 * Monatsbudget. Eine Überschreitung wird geloggt (Alarm) – der harte Bruch
 * passiert im Wake-Pfad (`assertFleetHourlyBudget`) und in der Prüf-Route.
 */
function budgetSnapshot(storageEurPerMonth = AI_ESTIMATED_STORAGE_EUR_PER_MONTH) {
  const allowed = GPU_ENDPOINT_ROLES.filter((role) => isRoleAllowed(role));
  const report = fleetBudgetReport(allowed, AI_HETZNER_EUR_PER_HOUR, storageEurPerMonth);
  if (!report.hourly.withinLimit) {
    aiLogger.error('fleet hourly budget exceeded', {
      totalEurPerHour: report.totalEurPerHour,
      limit: report.hourly.limit,
      error: report.hourly.violation,
    });
  }
  if (!report.storage.withinLimit) {
    aiLogger.error('storage budget exceeded', {
      storageEurPerMonth,
      limit: report.storage.limit,
      error: report.storage.violation,
    });
  }
  return report;
}

/**
 * Deterministische 16-Schritt-Patterns aus einem Seed (kein Netz, kein Zufall).
 * `/api/ai/compose` und der lokale Fallback von `/api/ai/generate` liefern
 * dieselbe Struktur - die Ableitung liegt deshalb genau einmal hier.
 */
function localTechnoPatterns(seed: number) {
  const kick = Array.from({ length: 16 }, (_, i) => (i + seed) % 4 === 0);
  const hat = Array.from({ length: 16 }, (_, i) => (i + seed) % 2 === 1);
  const clap = Array.from({ length: 16 }, (_, i) => i === 4 || i === 12);
  const synth = Array.from({ length: 16 }, (_, i) => (i + seed * 2) % 3 === 0);
  const synthNotes = Array.from({ length: 16 }, (_, i) => (i + seed) % 8);
  return {
    patterns: { kick, hat, clap, synth },
    synthNotes,
    bpm: 110 + (seed % 36), // 110–145
  };
}

export function registerAiRoutes(app: Express, deps: AiRouteDeps): void {
  // AI-P2-006: eine Instanz pro Serverprozess (Tests haengen ihre eigene ein).
  const cache: DropCache = deps.dropCache ?? dropCache;
  // Geteilte Referenzen aus server.ts. Bewusst als Objekt-Referenz: die
  // Flotten-Verdrahtung mutiert fleetTargets.ollama zur Laufzeit, und die
  // Metriken sind derselbe Zaehler wie in server.ts (keine Wertkopie).
  const { metrics, fleetTargets } = deps;

  // --- GET /api/ai/vision/artifact/:name → lokal abgelegte Vision-Medien ---
  // Fallback-Ablage, wenn R2 nicht verfügbar ist (siehe server/visionArtifacts.ts).
  // Token-frei wie /api/health (siehe Auth-Middleware oben); der Name wird streng
  // validiert: keine Pfadanteile, keine `..`, nur erlaubte Endungen.
  app.get('/api/ai/vision/artifact/:name', async (req, res) => {
    const name = String((req.params as { name?: string }).name ?? '');
    if (!isSafeArtifactName(name)) {
      return res.status(400).json({ error: 'invalid artifact name' });
    }
    const contentType = contentTypeForArtifact(name);
    if (!contentType) return res.status(400).json({ error: 'unsupported artifact type' });
    const body = await readArtifact(name);
    if (!body) return res.status(404).json({ error: 'artifact not found' });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.end(body);
  });

  // ===========================================================================
  // GAP-4: Eingangs-Validierung für /api/ai/* (Auth/Rate-Limit siehe Middleware)
  // ===========================================================================

  const AI_TASK_IDS = new Set<string>([
    'llm', 'tts', 'sing', 'song', 'stem.separate',
    'audio.classify', 'audio.transcribe', 'audio.embed',
    'audio.analyze', 'audio.generate', 'multimodal',
  ]);

  /** Task muss aus der zulässigen AiTask-Menge stammen (kein freies Routing). */
  function isValidAiTask(task: string): boolean {
    return AI_TASK_IDS.has(task);
  }

  /**
   * Modell-IDs werden in Provider-URLs eingesetzt. Erlaubt sind kurze
   * HuggingFace-artige IDs (owner/name), nicht aber URLs, Pfadtraversal,
   * Whitespace oder Steuerzeichen (SSRF-/Injection-Härtung).
   */
  function isValidModelId(model: string): boolean {
    if (model.length === 0 || model.length > 200) return false;
    if (model.includes('://') || model.includes('..')) return false;
    return /^[A-Za-z0-9._/-]+$/.test(model);
  }

  // --- POST /api/ai/compose  → deterministischer lokaler Preset-Generator ---
  app.post('/api/ai/compose', async (req, res) => {
    const parsed = AiPromptSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid prompt', details: parsed.error.issues.slice(0, 5) });
    const seed = (parsed.data.prompt?.trim().slice(0, 4000) || 'techno').length;

    // Deterministische Patterns aus dem Prompt-Seed ableiten (kein Netz).
    return res.json({
      task_id: 'local_' + Date.now(),
      ...localTechnoPatterns(seed),
      genre: 'Local Techno',
    });
  });


  // ---------------------------------------------------------------------------
  // POST /api/ai/generate + /api/ai/describe  → Ollama (lokal, self-hosted)
  // ---------------------------------------------------------------------------
  // Verdrahtet HyperSonicMOA-artige Anfragen an ein lokales Ollama-Modell.
  // Nutzt node>=18 global fetch; bei Fehler fällt es auf den deterministischen
  // lokalen Generator zurück (kein Cloud-Aufruf). Konfiguration via env:
  //   OLLAMA_URL    (Default http://127.0.0.1:11434)
  //   OLLAMA_MODEL  (Default qwen2.5:7b)
  // ---------------------------------------------------------------------------

  async function ollamaGenerate(promptText: string): Promise<string | null> {
    const url = (process.env.OLLAMA_URL || '').trim() || fleetTargets.ollama || 'http://127.0.0.1:11434';
    const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
    try {
      const resp = await fetch(`${url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: promptText, stream: false, options: { temperature: 0.7 } }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { response?: string };
      return data.response ?? null;
    } catch (e) {
      console.warn('[ollama] nicht erreichbar:', (e as Error).message);
      return null;
    }
  }

  function sanitizeJsonBlock(raw: string): string {
    let s = raw.trim();
    if (s.startsWith('```json')) s = s.slice(7);
    if (s.endsWith('```')) s = s.slice(0, -3);
    return s.trim();
  }

  // --- POST /api/ai/compose  → Ollama-gestützte KI-Komposition (mit lokalem Fallback) ---
  app.post('/api/ai/generate', async (req, res) => {
    const parsed = AiPromptSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid prompt', details: parsed.error.issues.slice(0, 5) });
    const query = (parsed.data.prompt?.trim().slice(0, 4000) || 'Dark warehouse techno drums');

    const llmPrompt =
      'Generiere ein valides JSON (nur JSON, keine Erklärung) mit Feldern ' +
      '{ bpm: number, genre: string, patterns: { kick:boolean[16], hat:boolean[16], clap:boolean[16], synth:boolean[16] }, synthNotes:number[16] } ' +
      'für einen Techno-Track basierend auf dem Prompt: "' + query + '".';

    const raw = await ollamaGenerate(llmPrompt);
    if (raw) {
      try {
        const parsed = JSON.parse(sanitizeJsonBlock(raw));
        return res.json({ task_id: 'ollama_' + Date.now(), source: 'ollama', ...parsed });
      } catch (e) {
        console.warn('[ollama] ungültiges JSON, Fallback.', e);
      }
    }

    // Deterministischer lokaler Fallback (kein Netz).
    const seed = query.length;
    return res.json({
      task_id: 'local_' + Date.now(), source: 'local',
      ...localTechnoPatterns(seed),
      genre: 'Local Techno',
    });
  });

  // --- POST /api/ai/describe  → Ollama-gestützte Beschreibung (Style/Mix-Empfehlung) ---
  app.post('/api/ai/describe', async (req, res) => {
    const parsed = AiPromptSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid prompt', details: parsed.error.issues.slice(0, 5) });
    const query = (parsed.data.prompt?.trim().slice(0, 4000) || 'Was ist ein guter Mix-Vorschlag ?');

    const llmPrompt =
      'Beantworte kurz (max 2 Sätze), auf Deutsch, fachlich für einen Musik-Produzenten: ' + query;

    const raw = await ollamaGenerate(llmPrompt);
    if (raw) {
      return res.json({ ai: raw.trim() });
    }
    return res.json({ ai: 'Ollama nicht erreichbar. (Lokaler Fallback: keine KI-Antwort verfügbar)' });
  });

  // --- POST /api/ai/voice/mos  → MOS-Harness (AI-P1-003 P2): Hörerwertung 1..5 ---
  // Request:  { modelId, language: 'DE'|'EN', score: 1..5, evaluatorId, notes? }
  // Response: { ok:true, summary } | { ok:false, error }
  app.post('/api/ai/voice/mos', (req, res) => {
    const parsed = MosRatingSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    }
    const result = mosHarness.add(parsed.data);
    if (!result.ok) return res.status(400).json(result);
    return res.status(201).json(result);
  });

  // --- GET /api/ai/voice/mos  → MOS-Gate-Status je Modell ---
  // AI-P1-007: laedt die gespeicherten Wertungen lazy nach (idempotent), damit
  // ein Server-Neustart sie nicht mehr verliert und die Antwort den Zustand
  // ehrlich ausweist (`persistence`).
  app.get('/api/ai/voice/mos', async (_req, res) => {
    await mosHarness.loadPersisted();
    return res.json({
      minScore: mosHarness.minScore,
      requiredCount: mosHarness.requiredCount,
      summaries: mosHarness.list(),
      persistence: mosHarness.persistenceStatus(),
    });
  });

  // --- POST /api/ai/vision  → VisualMONK: Bild aus Prompt/Stil/Audio-Features (FLUX) ---
  // Request:  { prompt, style?, bpm?, energy?, moodTags?, steps?, width?, height? }
  // Response: { status:'success', prompt, image(data-URI|URL), seed?, durationMs } | { status:'error', code, message }
  app.post('/api/ai/vision', async (req, res) => {
    metrics.aiRequests += 1;
    const parsed = AiVisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    }
    const body = parsed.data;
    const prompt = buildVisionPrompt({
      text: body.prompt,
      style: body.style,
      bpm: body.bpm,
      energy: body.energy,
      moodTags: body.moodTags,
    });
    try {
      const result = await generateVisionImage(prompt, {
        steps: body.steps,
        width: body.width,
        height: body.height,
      });

      // Persistenz (best effort): Bild nach R2 legen -> dauerhafte URL; ohne
      // R2-Konfiguration bleibt es beim data-URI (kein Fehler).
      let imageUrl: string | undefined;
      if (result.image.startsWith('data:image/')) {
        try {
          const comma = result.image.indexOf(',');
          const buf = Buffer.from(result.image.slice(comma + 1), 'base64');
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const up = await uploadSampleToR2(`vision/${stamp}-${result.seed ?? 'seed'}.png`, buf, 'image/png');
          imageUrl = up.url;
        } catch (e) {
          console.warn('[vision] R2-Ablage übersprungen:', String((e as Error).message).slice(0, 160));
        }
      }

      // Selbstlern-Loop (best effort): Generierung in Supabase ablegen.
      let generationId: string | undefined;
      try {
        const saved = await insertVisualGeneration({
          prompt,
          style: body.style,
          energy: body.energy,
          bpm: body.bpm,
          seed: result.seed,
          r2Url: imageUrl,
          durationMs: result.durationMs,
          model: 'flux-1-dev',
        });
        if (saved.ok) generationId = saved.id;
      } catch (e) {
        console.warn('[vision] Generierung nicht gespeichert:', String((e as Error).message).slice(0, 160));
      }

      return res.json({
        status: 'success',
        prompt: result.prompt,
        image: result.image,
        imageUrl,
        generationId,
        seed: result.seed,
        durationMs: result.durationMs,
      });
    } catch (e) {
      const err = e as Error;
      const code = err instanceof VisionError ? err.code : 'VISION_FAILED';
      const httpStatus = code === 'NO_ENDPOINT' || code === 'NO_KEY' || code === 'AI_DISABLED'
        || code === 'AI_VISUALS_OFF' || code === 'CIRCUIT_OPEN'
          ? 503 : code === 'TIMEOUT' ? 504 : 502;
      console.warn('[vision]', code, err.message?.slice(0, 200));
      return res.status(httpStatus).json({ status: 'error', code, message: String(err.message ?? 'vision failed').slice(0, 300) });
    }
  });

  // --- POST /api/ai/vision/video  -> Wan2.2 image->video (Rolle video) ---
  // Request: { imageBase64 | imageUrl, prompt?, steps?, width?, height?, cfg?, seed?, negativePrompt? }
  app.post('/api/ai/vision/video', async (req, res) => {
    metrics.aiRequests += 1;
    const parsed = AiVideoSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    }
    const b = parsed.data;
    let image = b.imageBase64 ?? '';
    if (!image && b.imageUrl) {
      try {
        const r = await fetch(b.imageUrl);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        image = Buffer.from(await r.arrayBuffer()).toString('base64');
      } catch (e) {
        return res.status(400).json({ error: `imageUrl nicht ladbar: ${String((e as Error).message).slice(0, 120)}` });
      }
    }
    try {
      const result = await generateVideo(image, b.prompt ?? '', {
        steps: b.steps, width: b.width, height: b.height, cfg: b.cfg, seed: b.seed, negativePrompt: b.negativePrompt,
      });
      let videoUrl: string | undefined;
      let videoStore: 'r2' | 'local' | null = null;
      try {
        const raw = Buffer.from(stripDataUri(result.video), 'base64');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        // saveArtifact: erst R2, sonst lokale Ablage (R2-Keys waren am 2026-09-11
        // ungültig – ohne Fallback ginge der Clip verloren).
        const up = await saveArtifact(`vision/video-${stamp}.mp4`, raw, 'video/mp4');
        videoUrl = up.url;
        videoStore = up.store;
      } catch (e) {
        console.warn('[video] Ablage fehlgeschlagen:', String((e as Error).message).slice(0, 160));
      }
      return res.json({ status: 'success', video: result.video, videoUrl, store: videoStore, durationMs: result.durationMs });
    } catch (e) {
      const err = e as Error;
      const code = err instanceof VideoError ? err.code : 'VIDEO_FAILED';
      const httpStatus = code === 'NO_ENDPOINT' || code === 'NO_KEY' || code === 'AI_DISABLED'
        || code === 'AI_VISUALS_OFF' || code === 'CIRCUIT_OPEN'
          ? 503 : code === 'TIMEOUT' ? 504 : 502;
      console.warn('[video]', code, err.message?.slice(0, 200));
      return res.status(httpStatus).json({ status: 'error', code, message: String(err.message ?? 'video failed').slice(0, 300) });
    }
  });

  // --- POST /api/ai/vision/clip  -> Text zu Clip (FLUX-Bild -> Wan2.2-Bewegung) ---
  // Request:  { prompt, style?, motion?, bpm?, energy?, moodTags?, imageSteps?,
  //             videoSteps?, width?, height?, videoWidth?, videoHeight?, seed? }
  // Response: { status:'success', image(data-URI), video(data-URI), imageUrl?,
  //             videoUrl?, store:{image,video}, imagePrompt, motionPrompt, seed,
  //             imageMs, videoMs, durationMs, generationId? }
  // Der Video-Worker ist image->video; „Text zu Video“ ist deshalb diese Kette.
  app.post('/api/ai/vision/clip', async (req, res) => {
    metrics.aiRequests += 1;
    const parsed = AiVideoClipSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    }
    const b = parsed.data;
    try {
      const clip = await generateClipFromPrompt({
        text: b.prompt,
        style: b.style,
        bpm: b.bpm,
        energy: b.energy,
        moodTags: b.moodTags,
        motion: b.motion,
        imageSteps: b.imageSteps,
        videoSteps: b.videoSteps,
        width: b.width,
        height: b.height,
        videoWidth: b.videoWidth,
        videoHeight: b.videoHeight,
        seed: b.seed,
        negativePrompt: b.negativePrompt,
      });

      // Ablage (best effort): R2 zuerst, sonst lokale Artefakt-URL. Ein Fehler
      // hier darf den fertigen Clip nicht verwerfen – der data-URI bleibt gültig.
      let imageArt: Awaited<ReturnType<typeof persistDataUri>> = null;
      let videoArt: Awaited<ReturnType<typeof persistDataUri>> = null;
      try {
        imageArt = await persistDataUri(clip.image, { keyPrefix: 'vision/clip-image', ext: 'png' });
        videoArt = await persistDataUri(clip.video, { keyPrefix: 'vision/clip', ext: 'mp4' });
      } catch (e) {
        console.warn('[clip] Ablage fehlgeschlagen:', String((e as Error).message).slice(0, 160));
      }

      // Selbstlern-Loop (best effort): Clip als Generierung ablegen.
      let generationId: string | undefined;
      try {
        const saved = await insertVisualGeneration({
          prompt: clip.imagePrompt,
          style: b.style,
          energy: b.energy,
          bpm: b.bpm,
          seed: clip.seed,
          r2Key: videoArt?.key,
          r2Url: videoArt?.url,
          durationMs: clip.durationMs,
          model: 'flux-1-dev+wan2.2',
        });
        if (saved.ok) generationId = saved.id;
      } catch (e) {
        console.warn('[clip] Generierung nicht gespeichert:', String((e as Error).message).slice(0, 160));
      }

      return res.json({
        status: 'success',
        image: clip.image,
        video: clip.video,
        imageUrl: imageArt?.url,
        videoUrl: videoArt?.url,
        store: { image: imageArt?.store ?? null, video: videoArt?.store ?? null },
        imagePrompt: clip.imagePrompt,
        motionPrompt: clip.motionPrompt,
        seed: clip.seed,
        imageMs: clip.imageMs,
        videoMs: clip.videoMs,
        durationMs: clip.durationMs,
        generationId,
      });
    } catch (e) {
      const err = e as Error;
      const code =
        err instanceof ClipPipelineError || err instanceof VisionError || err instanceof VideoError
          ? (err as { code: string }).code
          : 'CLIP_FAILED';
      const httpStatus = code === 'NO_ENDPOINT' || code === 'NO_KEY' || code === 'AI_DISABLED'
        || code === 'AI_VISUALS_OFF' || code === 'CIRCUIT_OPEN'
          ? 503 : code === 'TIMEOUT' ? 504 : 502;
      console.warn('[clip]', code, err.message?.slice(0, 200));
      return res.status(httpStatus).json({ status: 'error', code, message: String(err.message ?? 'clip failed').slice(0, 300) });
    }
  });

  // --- POST /api/ai/vision/show/merge  -> Clips der Show zu EINEM mp4 ---
  // Request:  { clips:[{url|dataUri, label?}], width?, height?, fps? }
  // Response: { status:'success', videoUrl, store, bytes, clipCount, mergeMs }
  // ffmpeg fehlt -> 503 NO_FFMPEG (kein stilles Nicht-Ergebnis).
  app.post('/api/ai/vision/show/merge', async (req, res) => {
    metrics.aiRequests += 1;
    const parsed = AiShowMergeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    }
    const b = parsed.data;

    const sources = [];
    for (let i = 0; i < b.clips.length; i++) {
      try {
        sources.push(await loadMergeSource(b.clips[i], i));
      } catch (e) {
        const err = e as MergeError;
        const code = err instanceof MergeError ? err.code : 'BAD_SOURCE';
        return res.status(code === 'NOT_FOUND' ? 404 : 400).json({
          status: 'error',
          code,
          message: String(err.message ?? 'Clip nicht ladbar').slice(0, 300),
        });
      }
    }

    try {
      const merged = await mergeClipBuffers(sources, { width: b.width, height: b.height, fps: b.fps });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        const art = await saveArtifact(`vision/show/${stamp}.mp4`, merged.video, 'video/mp4');
        return res.json({
          status: 'success',
          videoUrl: art.url,
          store: art.store,
          bytes: merged.bytes,
          clipCount: merged.clipCount,
          reencoded: merged.reencoded,
          mergeMs: merged.mergeMs,
          note: art.note,
        });
      } catch (e) {
        // Letzter Ausweg: die Show direkt ausliefern statt sie zu verlieren.
        console.warn('[show-merge] Ablage fehlgeschlagen:', String((e as Error).message).slice(0, 160));
        return res.json({
          status: 'success',
          video: `data:video/mp4;base64,${merged.video.toString('base64')}`,
          store: null,
          bytes: merged.bytes,
          clipCount: merged.clipCount,
          reencoded: merged.reencoded,
          mergeMs: merged.mergeMs,
        });
      }
    } catch (e) {
      const err = e as MergeError;
      const code = err instanceof MergeError ? err.code : 'MERGE_FAILED';
      const httpStatus = code === 'NO_FFMPEG' ? 503 : code === 'TIMEOUT' ? 504 : 502;
      console.warn('[show-merge]', code, err.message?.slice(0, 200));
      return res.status(httpStatus).json({ status: 'error', code, message: String(err.message ?? 'merge failed').slice(0, 300) });
    }
  });

  // --- POST /api/ai/vision/feedback  -> Session-Ende-Umfrage (Selbstlern-Loop) ---
  // Request: { generationId, rating(1..5), keep?, tags?, comment? }
  app.post('/api/ai/vision/feedback', async (req, res) => {
    const parsed = AiVisionFeedbackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    }
    const r = await insertVisualFeedback({
      generationId: parsed.data.generationId,
      rating: parsed.data.rating,
      keep: parsed.data.keep,
      tags: parsed.data.tags,
      comment: parsed.data.comment,
    });
    if (!r.ok) {
      const status = r.error === 'supabase-not-configured' ? 503 : 502;
      return res.status(status).json({ status: 'error', code: r.error });
    }
    return res.json({ status: 'success' });
  });

  // --- GET /api/ai/vision/styles  -> RAG-Stilvorschlag aus echten Bewertungen ---
  // Query: { energy?, bpm?, limit? }   (reine DB-Abfrage, KEIN GPU-Aufruf)
  // Response: { status:'success', suggestion:{style,source,reason,confidence},
  //             ranking:[{style,generations,avgRating,feedbackCount}],
  //             source:'db'|'none', note? }
  // Ohne Bewertungen ist die Quelle ehrlich `fallback` (Energie/Tempo-Heuristik);
  // ein fehlendes Supabase liefert `source:'none'` statt erfundener Zahlen.
  app.get('/api/ai/vision/styles', async (req, res) => {
    const parsed = AiVisionStylesQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }
    const { energy, bpm, limit } = parsed.data;
    const ranking = await fetchVisualStyleRanking(limit ?? 10);
    const rows = normalizeStyleRanking(ranking.rows);
    const suggestion = suggestStyleFromRanking(rows, { energy, bpm });
    return res.json({
      status: 'success',
      suggestion,
      ranking: rows,
      source: ranking.ok ? 'db' : 'none',
      ...(ranking.ok ? {} : { note: ranking.error }),
    });
  });

  // --- POST /api/ai/generate-drop  → dropMONK Drop-Generator (LLM + Fallback) ---
  // Request:  { userPrompt|prompt, context?: { bpm, activePlugins, currentEnergy }, style?, duration? }
  // Response: { name, description, category, parameterSequence, buildupTime,
  //             dropDuration, quantization, intensity, confidence, tags, source }
  app.post('/api/ai/generate-drop', async (req, res) => {
    metrics.aiRequests += 1;

    // ARCH-SEC-003: Zod-Runtime-Validierung statt unsicherem Cast.
    const parsed = AiGenerateDropSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    }
    const body = parsed.data;

    const userPrompt = (body.userPrompt ?? body.prompt ?? '').trim().slice(0, 2000);

    const rawBpm = Number(body.context?.bpm);
    const rawEnergy = Number(body.context?.currentEnergy);
    const rawDuration = Number(body.duration);
    const style: DropStyle = body.style ?? 'moderate';

    const dropRequest: DropGenerationRequest = {
      userPrompt,
      bpm: Number.isFinite(rawBpm) ? Math.max(40, Math.min(220, rawBpm)) : 128,
      activePlugins: Array.isArray(body.context?.activePlugins)
        ? (body.context!.activePlugins as unknown[]).map((p) => String(p).slice(0, 40)).slice(0, 20)
        : [],
      currentEnergy: Number.isFinite(rawEnergy) ? Math.max(0, Math.min(1, rawEnergy)) : 0.5,
      style,
      duration: Number.isFinite(rawDuration) ? Math.max(100, Math.min(32000, rawDuration)) : undefined,
    };

    const llmPrompt = buildDropPrompt(dropRequest);

    // AI-P2-006: Cache-Treffer VOR dem Modellaufruf. Zwei identische Anfragen
    // (Prompt, BPM, Energie, Plugins, Stil, Dauer) kosten so nur einen Aufruf.
    const cacheKey = cache.key(dropRequest);
    const cached = cache.get<Record<string, unknown>>(cacheKey);
    if (cached) {
      metrics.aiCacheHits += 1;
      return res.json({ ...cached, cached: true });
    }
    metrics.aiCacheMisses += 1;

    // 1) LLM-Router (API-Keys bleiben serverseitig)
    try {
      const completion = await llmRouter.complete({
        prompt: llmPrompt,
        complexity: 'moderate',
        maxTokens: 900,
        temperature: 0.7,
        reasoningEffort: 'low',
      });
      const payload = { ...sanitizeAiDropResponse(completion.text, dropRequest), provider: completion.provider };
      cache.set(cacheKey, payload);
      return res.json({ ...payload, cached: false });
    } catch (err) {
      console.warn('[generate-drop] LLM-Router nicht nutzbar:', (err as Error).message);
    }

    // 2) Lokales Ollama
    const raw = await ollamaGenerate(llmPrompt);
    if (raw) {
      try {
        const payload = { ...sanitizeAiDropResponse(raw, dropRequest), provider: 'ollama' };
        cache.set(cacheKey, payload);
        return res.json({ ...payload, cached: false });
      } catch (err) {
        console.warn('[generate-drop] ungültige Ollama-Antwort, Fallback.', (err as Error).message);
      }
    }

    // 3) Deterministischer lokaler Fallback (kein Netz, immer verfügbar).
    // Bewusst NICHT gecacht: er kostet nichts, und ein Cache-Treffer wuerde
    // verdecken, dass gerade kein Modell antwortet.
    metrics.aiFailures += 1;
    return res.json({ ...generateDeterministicDrop(dropRequest), provider: 'local', cached: false });
  });

  // --- POST /api/ai/complete  → LLM-Router (Keys bleiben serverseitig) ---
  app.post('/api/ai/complete', async (req, res) => {
    metrics.aiRequests += 1;
    // ARCH-SEC-003: Zod-Runtime-Validierung statt unsicherem Cast.
    const parsed = AiCompleteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid payload' });
    }
    const { prompt: clean, complexity, maxTokens, temperature, reasoningEffort } = parsed.data;

    const safeComplexity: 'simple' | 'moderate' | 'complex' = complexity ?? 'moderate';
    const safeReasoning: 'low' | 'high' | 'max' | undefined = reasoningEffort;

    try {
      const completion = await llmRouter.complete({
        prompt: clean,
        complexity: safeComplexity,
        maxTokens,
        temperature,
        reasoningEffort: safeReasoning,
      });
      return res.json(completion);
    } catch (err) {
      metrics.aiFailures += 1;
      const detail = err instanceof Error ? err.message : 'Unbekannter Fehler';
      return res.status(502).json({ error: 'ai complete fehlgeschlagen', detail });
    }
  });

  // ===========================================================================
  // AI Orchestrator – zentrale AI-Infrastruktur (Hetzner ↔ HF/Replicate/Supabase)
  // ===========================================================================

  // --- POST /api/ai/orchestrate  → AI-Job über den Orchestrator ---
  app.post('/api/ai/orchestrate', async (req, res) => {
    // ARCH-SEC-003: Zod-Runtime-Validierung statt unsicherem Cast.
    const parsed = AiOrchestrateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(422).json({ error: 'invalid orchestrate payload', details: parsed.error.issues.slice(0, 5) });
    }
    const { userId, task, model, input, sessionId } = parsed.data;
    const safeTask = task as AiTask;
    const safeModel = model;
    if (!isValidAiTask(safeTask)) {
      return res.status(422).json({ error: 'unknown task', task: safeTask.slice(0, 80) });
    }
    if (!isValidModelId(safeModel)) {
      return res.status(422).json({ error: 'invalid model id' });
    }
    metrics.aiRequests += 1;
    // AI-P1-004: Idempotenz-Schlüssel (Standard-Header, z. B. bei Retries).
    const idempotencyKey = String(req.header('idempotency-key') ?? '').trim().slice(0, 200);

    // INFRA-AI-007: Das MOS-Gate (Hörerwertung) entscheidet über das TTS-Modell.
    // Es war bis 2026-09-20 ohne Abnehmer; jetzt hängt die erste echte
    // Entscheidung daran: ein Modell mit genug Hörern UNTER der Schwelle wird
    // nicht verwendet – entweder auf einen erlaubten Kandidaten gewechselt oder
    // (wenn alles durchgefallen ist) mit 409 abgelehnt.
    let effectiveModel = safeModel;
    let mosDecision: ReturnType<typeof resolveVoiceModel> | null = null;
    if (safeTask === 'tts' || safeTask === 'sing') {
      mosDecision = resolveVoiceModel(safeModel);
      if (mosDecision.status === 'blocked') {
        metrics.aiFailures += 1;
        console.warn('[mos-gate] TTS-Modell abgelehnt:', mosDecision.reason.slice(0, 300));
        return res.status(409).json({
          error: 'tts model blocked by mos gate',
          code: 'MOS_GATE_BLOCKED',
          requested: mosDecision.requested,
          reason: mosDecision.reason,
          considered: mosDecision.considered,
        });
      }
      if (mosDecision.switched) {
        console.log(`[mos-gate] TTS-Modell gewechselt: ${mosDecision.reason.slice(0, 240)}`);
      }
      effectiveModel = mosDecision.model;
    }

    try {
      const result = await aiOrchestrator.orchestrate({
        userId: String(userId ?? 'localUser').slice(0, 64),
        task: safeTask,
        model: effectiveModel,
        input: input ?? {},
        sessionId: sessionId,
        idempotencyKey: idempotencyKey || undefined,
      });
      void aiPersistence.saveJob(result.job);
      void aiPersistence.saveSession(aiOrchestrator.sessions.get());
      return res.json(mosDecision ? { ...result, mosGate: mosDecision } : result);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return res.status(409).json({
          error: 'idempotency key already used with a different payload',
          code: 'IDEMPOTENCY_CONFLICT',
          jobId: err.jobId,
        });
      }
      metrics.aiFailures += 1;
      const message = err instanceof Error ? err.message : 'AI-Orchestrierung fehlgeschlagen';
      const status = message.includes('INSUFFICIENT_CREDIT') ? 402 : message.includes('RATE_LIMITED') ? 429 : 502;
      return res.status(status).json({ error: message });
    }
  });

  // --- GET /api/ai/orchestrator/status ---
  app.get('/api/ai/orchestrator/status', (_req, res) => {
    return res.json(aiOrchestrator.getStatus());
  });

  // --- GET /api/ai/jobs + /api/ai/jobs/:jobId ---
  app.get('/api/ai/jobs', (req, res) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    return res.json({ jobs: aiOrchestrator.jobs.list(sessionId || undefined) });
  });

  app.get('/api/ai/jobs/:jobId', (req, res) => {
    const job = aiOrchestrator.jobs.get(String(req.params.jobId));
    if (!job) return res.status(404).json({ error: 'job not found' });
    return res.json(job);
  });

  // AI-P1-002: laufenden/wartenden AI-Job abbrechen (Slot wird sofort frei,
  // AbortSignal erreicht den Provider).
  app.post('/api/ai/jobs/:jobId/cancel', (req, res) => {
    const jobId = String(req.params.jobId);
    const job = aiOrchestrator.jobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    const cancelled = aiOrchestrator.cancelJob(jobId, 'api-cancel');
    return res.json({ jobId, cancelled, status: aiOrchestrator.jobs.get(jobId)?.status ?? job.status });
  });

  // --- Session-Lifecycle ---
  app.get('/api/ai/session', (_req, res) => res.json(aiOrchestrator.sessions.get()));

  app.post('/api/ai/session/heartbeat', (_req, res) => {
    aiOrchestrator.sessions.heartbeat();
    return res.json(aiOrchestrator.sessions.get());
  });

  app.post('/api/ai/session/shutdown', async (_req, res) => {
    await aiOrchestrator.sessions.shutdown();
    return res.json(aiOrchestrator.sessions.get());
  });

  // --- GPU-Flotte: Status / Session-Wake / Sleep ---
  // Die drei Rollen-Endpoints (brain/ears/voiceGen) skalieren auf 0. Beim
  // Studio-Eintritt weckt der Client die Flotte vorab (workersMin=1 je Endpoint +
  // Warmup-Job, der die Preload-Modelle in VRAM lädt); beim Session-Ende bzw.
  // Idle-Timeout wird sie wieder schlafen gelegt. Statusabfrage ohne Netzwerk.
  app.get('/api/ai/fleet/status', (_req, res) => {
    return res.json(fleetStatus());
  });

  app.post('/api/ai/fleet/wake', async (req, res) => {
    // INFRA-FEAT-002: Ein Wake darf gezielt Rollen anfordern (Visual-Abruf).
    // Ohne `roles` weckt er – wie bisher – die immer-Rollen; Visual-Rollen
    // bleiben außen vor (Konstitution §2).
    const requestedRaw = (req.body as { roles?: unknown } | undefined)?.roles;
    const requested: GpuEndpointRole[] = [];
    if (requestedRaw !== undefined) {
      if (!Array.isArray(requestedRaw)) {
        return res.status(400).json({ error: 'roles muss ein Array von Rollen-IDs sein' });
      }
      for (const entry of requestedRaw) {
        const role = String(entry) as GpuEndpointRole;
        if (!GPU_ENDPOINT_ROLES.includes(role)) {
          return res.status(422).json({ error: `unbekannte Rolle: ${String(entry).slice(0, 40)}` });
        }
        requested.push(role);
      }
    }
    try {
      const report = await wakeFleet(requested.length > 0
        ? { roles: requested, purpose: requested.some(isVisualRole) ? 'visual-on-demand' : 'session' }
        : { purpose: 'session' });
      // AI aus / Visuals gesperrt / Budget gerissen: kein Netzwerkaufruf, klar
      // als 409 mit Grund – der Aufrufer soll nicht „erfolgreich“ annehmen.
      if (report.blocked) {
        return res.status(409).json(report);
      }
      return res.json(report);
    } catch (err) {
      return res.status(502).json({ error: err instanceof Error ? err.message : 'fleet wake failed' });
    }
  });

  // --- Betriebsmodus der AI-Flotte (INFRA-FEAT-001/002) ---------------------
  // Der Schalter mit echter Wirkung: `off` stoppt jeden RunPod-Aufruf,
  // `on-no-visuals` sperrt die Visual-Rollen, `on-with-visuals` erlaubt sie bei
  // Abruf. Quelle des Defaults ist `AI_MODE` (siehe aiGate.ts).
  app.get('/api/ai/mode', (_req, res) => {
    return res.json({ ...aiGateStatus(GPU_ENDPOINT_ROLES), budget: budgetSnapshot() });
  });

  app.post('/api/ai/mode', (req, res) => {
    const parsed = AiModeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(422).json({ error: parsed.error.issues[0]?.message ?? 'invalid mode payload' });
    }
    const previous = getAiOperatingMode();
    const mode = setAiOperatingMode(parsed.data.mode as AiOperatingMode, {
      source: parsed.data.source ?? 'api',
    });
    if (previous !== mode) {
      console.log(`[ai-mode] ${previous} -> ${mode} (Quelle: ${parsed.data.source ?? 'api'})`);
    }
    return res.json({ ...aiGateStatus(GPU_ENDPOINT_ROLES), budget: budgetSnapshot() });
  });

  // --- Budget-Prüfung (INFRA-FEAT-003) --------------------------------------
  // Reine Prüf-Route für Ops/Preflight (z. B. vor dem Snapshot-Schritt):
  // Überschreitung ist ein harter 409 mit der Guard-Meldung.
  app.post('/api/ai/budget/check', (req, res) => {
    const body = (req.body ?? {}) as { storageEurPerMonth?: unknown };
    const storageEurPerMonth = Number.isFinite(Number(body.storageEurPerMonth))
      ? Number(body.storageEurPerMonth)
      : AI_ESTIMATED_STORAGE_EUR_PER_MONTH;
    const snapshot = budgetSnapshot(storageEurPerMonth);
    const violations = [
      ...(snapshot.hourly.withinLimit ? [] : [snapshot.hourly.violation ?? 'Stundenbudget gerissen']),
      ...(snapshot.storage.withinLimit ? [] : [snapshot.storage.violation ?? 'Speicherbudget gerissen']),
    ];
    return res.status(violations.length === 0 ? 200 : 409).json({ ok: violations.length === 0, violations, budget: snapshot });
  });

  app.post('/api/ai/fleet/sleep', async (_req, res) => {
    try {
      return res.json(await sleepFleet());
    } catch (err) {
      return res.status(502).json({ error: err instanceof Error ? err.message : 'fleet sleep failed' });
    }
  });

  // --- Model Registry / Status ---
  app.get('/api/ai/models', (_req, res) => {
    return res.json({ models: aiOrchestrator.models.getModelInfo() });
  });

  // --- MCP Runtime (Permission-geschützt) ---
  app.get('/api/ai/mcp/tools', (_req, res) => {
    return res.json({ tools: aiOrchestrator.mcp.listTools() });
  });

  app.post('/api/ai/mcp/tools/:name', async (req, res) => {
    const name = String(req.params.name).trim().slice(0, 120);
    if (!aiOrchestrator.mcp.hasTool(name)) return res.status(404).json({ error: 'unknown tool' });
    const parsedArgs = McpToolInvokeSchema.safeParse(req.body ?? {});
    if (!parsedArgs.success) {
      return res.status(400).json({ error: parsedArgs.error.issues[0]?.message ?? 'invalid arguments' });
    }
    const args = parsedArgs.data as Record<string, unknown>;
    const result = await aiOrchestrator.mcp.invoke(name, args);
    void aiPersistence.auditMcp(name, 'localUser', aiOrchestrator.sessions.get().sessionId, result.ok, String((args as { permission?: string }).permission ?? 'READ'));
    return res.json(result);
  });

}
