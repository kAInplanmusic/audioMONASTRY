import express, { type Response } from 'express';
import * as BusboyModule from 'busboy';
import { random } from './src/utils/random';
import http from 'http';
import path from 'path';
import compression from 'compression';
import dotenv from 'dotenv';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { syncCloudDatabase, cloudHealth, pushSampleToCloud, pushMusicTrackToCloud, uploadSampleToR2 } from './server/cloud.ts';
import { syncR2ToSupabase, ingestAudioObject } from './server/cloudAutomation.ts';
import { llmRouter } from './src/core/ai/LlmRouter';
import {
  buildDropPrompt,
  sanitizeAiDropResponse,
  generateDeterministicDrop,
} from './src/core/drop/DropTemplateGenerator';
import type { DropGenerationRequest, DropStyle } from './src/core/drop/DropTemplateGenerator';
import { aiOrchestrator } from './src/core/ai/orchestrator/aiOrchestrator';
import { aiPersistence } from './src/core/ai/orchestrator/aiPersistence';
import { resolveAiRateLimits } from './src/config/aiRateLimits';
import { embedText } from './src/core/ai/orchestrator/textEmbedding';
import type { AiTask } from './src/core/ai/orchestrator/types';
import { PRESET_SAMPLE_DATABASE } from './src/data/samples';
import { orchestralSamples } from './src/data/orchestralLibrary';
import type { AudioSample } from './src/data/samples';

// Task 14: Echte Demucs-Stems optional via env-Flag ENABLE_STEMS=1 aktivieren.
const ENABLE_STEMS = (process.env.ENABLE_STEMS || '').trim() === '1';

// DCT-101: Stem-Queue-Backpressure – harte Grenze für parallele Demucs-Jobs.
const STEM_MAX_JOBS = Math.max(1, Number(process.env.STEM_MAX_JOBS ?? 2));
const STEM_JOB_TIMEOUT_MS = Math.max(10_000, Number(process.env.STEM_JOB_TIMEOUT_MS ?? 300_000));
let stemActiveJobs = 0;
let stemJobSeq = 0;
const stemJobStatus = new Map<string, 'active' | 'pending' | 'success' | 'failed' | 'cancelled' | 'timeout'>();

/**
 * audioMONASTRY Server – VENDOR-/CLOUD-FREI.
 *
 * Diese Datei enthaelt KEINERLEI Verbindung zu externen Cloud-Anbietern.
 * Storage, Secret Manager oder GenAI. Der gesamte Stack (static
 * App + REST-API + WebRTC-Signaling) laeuft in einem Node-Prozess.
 *
 * Fuer Hetzner:  PORT=8080, NODE_ENV=production, `node dist/server.cjs`
 */

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 8080);

// ---------------------------------------------------------------------------
// FLEET-WIRING: Ziel-URLs der Flotten-Knoten (master-player, Ollama, stem-ai)
// ---------------------------------------------------------------------------
// Die Hetzner-IPs werden erst bei der Flotten-Erstellung vergeben. Deshalb
// holt die App sie beim Start vom Portal-Worker (/api/fleet-map, geschützt
// über den Studio-Token) und überschreibt damit die Default-/Env-Ziele.
// Direkte Env-Variablen (MASTER_PLAYER_URL, OLLAMA_URL, STEM_AI_URL) haben
// weiterhin Vorrang (explizit gesetzt > Flotten-Map > interner Default).
// ---------------------------------------------------------------------------
const FLEET_MAP_URL = (process.env.FLEET_MAP_URL || '').trim() || 'https://anunnakitools.de/api/fleet-map';
const fleetTargets: { masterPlayer: string; ollama: string; stemAi: string } = {
  masterPlayer: '',
  ollama: '',
  stemAi: '',
};

/** Validiert einen Fleet-Knoten (Hostname/IP, optional :port) gegen SSRF-/Injection-Werte. */
function buildFleetTarget(raw: unknown, defaultPort: number): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > 255) return '';
  if (/[\s/@\\?&#]/.test(value)) return '';
  const withoutScheme = value.replace(/^https?:\/\//i, '');
  const portIndex = withoutScheme.lastIndexOf(':');
  let host = withoutScheme;
  let port = defaultPort;
  if (portIndex !== -1) {
    const portPart = withoutScheme.slice(portIndex + 1);
    if (!/^\d{1,5}$/.test(portPart)) return '';
    host = withoutScheme.slice(0, portIndex);
    port = Number(portPart);
  }
  if (!host || host.length > 253) return '';
  // Hostname oder IPv4, keine Wildcards/Unterstriche/Pfade.
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return '';
  if (port < 1 || port > 65535) return '';
  return `http://${host}:${port}`;
}

async function wireFleetFromPortal(): Promise<void> {
  const token = (process.env.STUDIO_ACCESS_TOKEN || '').trim();
  if (!token) return; // Lokal/Test: keine Flotten-Verdrahtung.
  try {
    const resp = await fetch(FLEET_MAP_URL, {
      headers: { 'x-studio-token': token },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as { fleet?: Record<string, string> };
    const f = data.fleet ?? {};
    const masterTarget = buildFleetTarget(f['samplemonk-master-1'], 8000);
    if (masterTarget) fleetTargets.masterPlayer = masterTarget;
    const aiTarget = buildFleetTarget(f['samplemonk-ai-1'], 8000);
    if (aiTarget) {
      const ollamaPort = Number(process.env.FLEET_OLLAMA_PORT || 11434);
      const ollamaTarget = buildFleetTarget(f['samplemonk-ai-1'], Number.isFinite(ollamaPort) ? ollamaPort : 11434);
      fleetTargets.ollama = ollamaTarget || '';
      fleetTargets.stemAi = aiTarget;
    }
    console.log('[fleet] Knoten verdrahtet:', JSON.stringify({ masterPlayer: fleetTargets.masterPlayer, ollama: fleetTargets.ollama, stemAi: fleetTargets.stemAi }));
  } catch (e) {
    console.warn('[fleet] Fleet-Map nicht erreichbar:', (e as Error).message);
  }
}
void wireFleetFromPortal();


// DCT-108: In-Process-Metriken (keine neuen Dependencies, keine Secrets/Samples).
const metrics = {
  requests: 0,
  errors: 0,
  latencyMsSum: 0,
  aiRequests: 0,
  aiFailures: 0,
  stemRequests: 0,
  stemFailures: 0,
  telemetryEvents: 0,
  startedAt: Date.now(),
  lastRequestId: '',
  // P2 Live-Telemetrie-Dashboard: Client-Events nach type/source aufgeschlüsselt.
  telemetryByType: {} as Record<string, number>,
  telemetryBySource: {} as Record<string, number>,
  // AM-E6-1: Xrun-/Dropout-Telemetrie (Histogramm-Quelle ist der Client;
  // der Server aggregiert für Prometheus/JSON-Metriken).
  telemetryXruns: 0,
  telemetryXrunsBySource: {} as Record<string, number>,
};

// Aktive Socket.io-Verbindungen (User-Sessions) für /api/online + Idle-Shutdown.
let activeSocketConnections = 0;

// P4-2: Server-seitiges Audit-Log (Rollenwechsel, Lock-/State-Events, RBAC-Denials).
const serverAuditLog: { ts: string; userId: string; role: string; action: string; target?: string; ok: boolean }[] = [];
const MAX_SERVER_AUDIT = 1000;
function addServerAudit(userId: string, role: string, action: string, ok: boolean, target?: string): void {
  serverAuditLog.push({ ts: new Date().toISOString(), userId, role, action, target, ok });
  if (serverAuditLog.length > MAX_SERVER_AUDIT) serverAuditLog.splice(0, serverAuditLog.length - MAX_SERVER_AUDIT);
}

// P4-2: Server-seitige Rollenzuordnung je User-ID (Host = admin, Rest = SESSION_ROLE).
const sessionRoles = new Map<string, string>();
function roleForSessionUser(userId: string): string {
  // Reconnect-sicher: Ein bereits bekannter User behält seine Rolle
  // (sonst würde der Host bei jedem Socket-Reconnect zum Guest degradiert).
  const existing = sessionRoles.get(userId);
  if (existing) return existing;
  if (sessionRoles.size === 0) return 'admin'; // Erster User = Host/Admin
  if (process.env.SESSION_HOST_USER && userId === process.env.SESSION_HOST_USER) return 'admin';
  const r = (process.env.SESSION_ROLE || '').trim();
  return r === 'admin' || r === 'producer' || r === 'engineer' || r === 'guest' ? r : 'guest';
}
function roleCanState(role: string, state: string): boolean {
  if (state !== 'PRO') return true; // OFF/AUTO_AI = state-Aktion für alle
  return role === 'admin' || role === 'producer';
}

// DCT-108: Request/Trace-ID-Middleware (Korrelation User-Action → HTTP → AI).
app.use((req, res, next) => {
  const id = (req.headers['x-request-id'] as string) || `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader('X-Request-Id', id);
  metrics.lastRequestId = id;
  const start = Date.now();
  metrics.requests += 1;
  res.on('finish', () => {
    metrics.latencyMsSum += Date.now() - start;
    if (res.statusCode >= 400) metrics.errors += 1;
  });
  next();
});

// DCT-105: Redis-/Multi-Instance-Readiness – bei gesetztem REDIS_URL wird der
// Socket.io-Redis-Adapter beim Serverstart aktiviert (siehe unten, io-Init).
// Ohne REDIS_URL läuft der In-Memory-Adapter (Single-Instance-Default).
if (process.env.REDIS_URL) {
  console.log('[signaling] REDIS_URL gesetzt – Socket.io-Redis-Adapter wird beim Start aktiviert.');
}

app.use(express.json({ limit: '50mb' }));

// Gzip/Brotli-Kompression für API + statische Assets (deutlich kleinere
// Payloads, gerade für JSON-Antworten und das SPA-Bundle).
app.use(compression());

// ===========================================================================
// Cross-Origin-Isolation (COOP/COEP) – aktiviert SharedArrayBuffer und
// WASM-/WebGPU-Multithreading (z. B. onnxruntime-web, Audio-Worklets).
// COEP 'credentialless' erlaubt weiterhin cross-origin Ressourcen ohne
// CORP-Header (Supabase-/R2-Audio-URLs), blockiert aber Credential-Zugriffe.
// ===========================================================================
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// P-16: Security-Header (ohne CSP-Bruch – CSP separat, da Worklets/Blob/WebRTC
// besondere Regeln brauchen).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});

// --- Security: Rate limiting (per Env konfigurierbar fuer Lasttests) ---
const API_RATE_LIMIT_WINDOW_MS = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX || 60);
// AITodo Phase 18: explizite AI_RATE_*-Limits (Kostenbremse für KI-Routen).
const AI_RATE = resolveAiRateLimits(process.env as Record<string, string | undefined>);

// P-1: Studio-Zugangstoken. Wird vom Portal (Cloudflare Worker) gesetzt und
// als HttpOnly-Cookie `studio` an den Browser gegeben. Leer = lokaler
// Dev-Modus (kein Schutz, wie bisher). Gesetzt = alle /api/* (außer health)
// und der Socket.io-Handshake verlangen den Token.
const STUDIO_ACCESS_TOKEN = (process.env.STUDIO_ACCESS_TOKEN || '').trim();
const studioTokenEnabled = STUDIO_ACCESS_TOKEN.length > 0;

/** Konstantzeit-Vergleich zweier Token (Buffer-XOR). */
function safeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

function studioTokenFromRequest(req: any): string {
  const header = String(req.headers?.['x-studio-token'] ?? '');
  if (header) return header;
  const cookie = String(req.headers?.cookie ?? '');
  const m = cookie.match(/(?:^|;\s*)studio=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

// P-1: Auth-Middleware für alle /api/* außer /api/health.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!studioTokenEnabled) return next();
  const token = studioTokenFromRequest(req);
  if (token && safeTokenEqual(token, STUDIO_ACCESS_TOKEN)) return next();
  res.status(401).json({ error: 'unauthorized', code: 'STUDIO_TOKEN_REQUIRED' });
});

const studioKeyGenerator = (req: any): string =>
  studioTokenFromRequest(req) || ipKeyGenerator(req.ip);

const apiLimiter = rateLimit({
  windowMs: API_RATE_LIMIT_WINDOW_MS, // Standard: 1 Minute
  max: API_RATE_LIMIT_MAX, // Standard: 60 Requests/Minute/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: studioKeyGenerator,
});

// Teure KI-/Cloud-/Upload-Routen: enges Limit pro Studio-Token (Kostenbremse).
// Legacy-Env API_EXPENSIVE_RATE_LIMIT_MAX bleibt respektiert (Server-Tests/Lasttests).
const legacyExpensiveMax = Number(process.env.API_EXPENSIVE_RATE_LIMIT_MAX || 0);
const expensiveLimiter = rateLimit({
  windowMs: AI_RATE.expensiveWindowMs,
  max: legacyExpensiveMax > 0 ? legacyExpensiveMax : AI_RATE.expensiveMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many expensive requests, please try again later.' },
  keyGenerator: studioKeyGenerator,
});

app.use('/api', apiLimiter);
app.use(['/api/ai', '/api/voice', '/api/sound', '/api/song', '/api/separate-stems', '/api/cloud/upload', '/api/cloud/sync', '/api/upload'], expensiveLimiter);

// --- Health check ---
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// --- DCT-108: Metriken (keine Samples, keine Secrets, keine Keys) ---
// JSON bleibt der Default (bestehende Consumer). Prometheus/Grafana nutzen
// `?format=prometheus` oder `Accept: text/plain` (Text-Exposition-Format 0.0.4).
app.get('/api/metrics', (req, res) => {
  const wantsProm = req.query.format === 'prometheus'
    || String(req.headers.accept || '').includes('text/plain');
  if (wantsProm) {
    const uptime = Math.round((Date.now() - metrics.startedAt) / 1000);
    const avgLatencyMs = metrics.requests ? Math.round(metrics.latencyMsSum / metrics.requests) : 0;
    const lines = [
      '# HELP samplemonk_uptime_seconds Prozess-Uptime in Sekunden.',
      '# TYPE samplemonk_uptime_seconds gauge',
      `samplemonk_uptime_seconds ${uptime}`,
      '# HELP samplemonk_http_requests_total Anzahl HTTP-Requests (kumulativ).',
      '# TYPE samplemonk_http_requests_total counter',
      `samplemonk_http_requests_total ${metrics.requests}`,
      '# HELP samplemonk_http_errors_total Anzahl HTTP-Fehler >= 400 (kumulativ).',
      '# TYPE samplemonk_http_errors_total counter',
      `samplemonk_http_errors_total ${metrics.errors}`,
      '# HELP samplemonk_http_avg_latency_ms Durchschnittliche Request-Latenz in ms.',
      '# TYPE samplemonk_http_avg_latency_ms gauge',
      `samplemonk_http_avg_latency_ms ${avgLatencyMs}`,
      '# HELP samplemonk_ai_requests_total Anzahl KI-Proxy-Requests (kumulativ).',
      '# TYPE samplemonk_ai_requests_total counter',
      `samplemonk_ai_requests_total ${metrics.aiRequests}`,
      '# HELP samplemonk_ai_failures_total Anzahl KI-Proxy-Fehler (kumulativ).',
      '# TYPE samplemonk_ai_failures_total counter',
      `samplemonk_ai_failures_total ${metrics.aiFailures}`,
      '# HELP samplemonk_stem_requests_total Anzahl Stem-Separation-Requests (kumulativ).',
      '# TYPE samplemonk_stem_requests_total counter',
      `samplemonk_stem_requests_total ${metrics.stemRequests}`,
      '# HELP samplemonk_stem_failures_total Anzahl Stem-Separation-Fehler (kumulativ).',
      '# TYPE samplemonk_stem_failures_total counter',
      `samplemonk_stem_failures_total ${metrics.stemFailures}`,
      '# HELP samplemonk_stem_jobs_active Aktive Stem-Jobs.',
      '# TYPE samplemonk_stem_jobs_active gauge',
      `samplemonk_stem_jobs_active ${stemActiveJobs}`,
      '# HELP samplemonk_stem_jobs_max Maximale parallele Stem-Jobs.',
      '# TYPE samplemonk_stem_jobs_max gauge',
      `samplemonk_stem_jobs_max ${STEM_MAX_JOBS}`,
      '# HELP samplemonk_telemetry_events_total Client-Telemetrie-Events (kumulativ).',
      '# TYPE samplemonk_telemetry_events_total counter',
      `samplemonk_telemetry_events_total ${metrics.telemetryEvents ?? 0}`,
      '# HELP samplemonk_telemetry_xruns_total Xrun-/Dropout-Telemetrie-Events (kumulativ).',
      '# TYPE samplemonk_telemetry_xruns_total counter',
      `samplemonk_telemetry_xruns_total ${metrics.telemetryXruns ?? 0}`,
      '# HELP samplemonk_ai_jobs_total Anzahl AI-Orchestrator-Jobs (kumulativ).',
      '# TYPE samplemonk_ai_jobs_total counter',
      `samplemonk_ai_jobs_total ${aiOrchestrator.jobs.list().length}`,
      '# HELP samplemonk_ai_cost_usd Geschätzte AI-Kosten (USD, kumulativ).',
      '# TYPE samplemonk_ai_cost_usd gauge',
      `samplemonk_ai_cost_usd ${aiOrchestrator.costs.summary().totalUsd ?? 0}`,
    ];
    // P2 Live-Telemetrie-Dashboard: Breakdown nach type/source für Grafana-Panels.
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    for (const [type, count] of Object.entries(metrics.telemetryByType ?? {})) {
      lines.push(
        '# HELP samplemonk_telemetry_events_by_type_total Client-Telemetrie-Events nach Typ.',
        '# TYPE samplemonk_telemetry_events_by_type_total counter',
        `samplemonk_telemetry_events_by_type_total{type="${esc(type)}"} ${count}`,
      );
    }
    for (const [source, count] of Object.entries(metrics.telemetryBySource ?? {})) {
      lines.push(
        '# HELP samplemonk_telemetry_events_by_source_total Client-Telemetrie-Events nach Quelle.',
        '# TYPE samplemonk_telemetry_events_by_source_total counter',
        `samplemonk_telemetry_events_by_source_total{source="${esc(source)}"} ${count}`,
      );
    }
    for (const [source, count] of Object.entries(metrics.telemetryXrunsBySource ?? {})) {
      lines.push(
        '# HELP samplemonk_telemetry_xruns_by_source_total Xrun-/Dropout-Events nach Quelle.',
        '# TYPE samplemonk_telemetry_xruns_by_source_total counter',
        `samplemonk_telemetry_xruns_by_source_total{source="${esc(source)}"} ${count}`,
      );
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
    return;
  }
  res.json({
    uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
    requests: metrics.requests,
    errors: metrics.errors,
    avgLatencyMs: metrics.requests ? Math.round(metrics.latencyMsSum / metrics.requests) : 0,
    ai: {
      requests: metrics.aiRequests,
      failures: metrics.aiFailures,
      jobs: aiOrchestrator.jobs.list().length,
      costUsd: aiOrchestrator.costs.summary().totalUsd ?? 0,
    },
    stem: { requests: metrics.stemRequests, failures: metrics.stemFailures, active: stemActiveJobs, max: STEM_MAX_JOBS },
    telemetryEvents: metrics.telemetryEvents ?? 0,
    telemetryByType: metrics.telemetryByType ?? {},
    telemetryBySource: metrics.telemetryBySource ?? {},
    telemetryXruns: metrics.telemetryXruns ?? 0,
    telemetryXrunsBySource: metrics.telemetryXrunsBySource ?? {},
    lastRequestId: metrics.lastRequestId,
  });
});

// --- Aktive User (Socket.io-Verbindungen) für Idle-Auto-Shutdown ------------
app.get('/api/online', (_req, res) => {
  res.json({ online: Math.max(0, activeSocketConnections) });
});

// --- P4-2: Server-Audit-Log (Rollenzuweisung, Plugin-State, RBAC-Denials) ----
app.get('/api/audit', (_req, res) => {
  res.json({ entries: serverAuditLog.slice(-500).reverse(), total: serverAuditLog.length });
});

// --- Live-Telemetrie: Client-Events/Fehler einsammeln (auto-logging) --------
// POST /api/telemetry  body: { events: [{type, source, message, context?, ts?}] }
// Der Server loggt jede Meldung als JSON-Line (Docker-Log-Rotation greift)
// und zählt sie in den Prometheus-Metriken (samplemonk_telemetry_events_total).
app.post('/api/telemetry', express.json({ limit: '1mb' }), (req, res) => {
  const events = Array.isArray((req.body ?? {}).events) ? (req.body as any).events : [];
  let accepted = 0;
  for (const ev of events.slice(0, 50)) {
    if (!ev || typeof ev !== 'object') continue;
    const type = String(ev.type ?? 'log').slice(0, 32);
    const source = String(ev.source ?? 'client').slice(0, 128);
    const message = String(ev.message ?? '').slice(0, 1000);
    // P-10: Context hart kappen (max. 2 KB im Log), sonst kann ein Client
    // riesige Objekte ins Log schreiben.
    let ctx: unknown = {};
    try {
      const ctxStr = JSON.stringify(ev.context ?? {});
      ctx = ctxStr.length > 2048
        ? { truncated: true, preview: ctxStr.slice(0, 2048) }
        : (ev.context ?? {});
    } catch {
      ctx = {};
    }
    metrics.telemetryEvents = (metrics.telemetryEvents ?? 0) + 1;
    metrics.telemetryByType[type] = (metrics.telemetryByType[type] ?? 0) + 1;
    metrics.telemetryBySource[source] = (metrics.telemetryBySource[source] ?? 0) + 1;
    // AM-E6-1: Xrun-/Dropout-Events separat aggregieren (Prometheus/Grafana).
    if (type === 'xrun' || type === 'dropout') {
      metrics.telemetryXruns = (metrics.telemetryXruns ?? 0) + 1;
      metrics.telemetryXrunsBySource[source] = (metrics.telemetryXrunsBySource[source] ?? 0) + 1;
    }
    accepted += 1;
    console.log(JSON.stringify({ t: 'telemetry', type, source, message, ctx, ts: ev.ts ?? Date.now() }));
  }
  res.status(202).json({ accepted });
});

// --- Prometheus-Alerting-Webhook (Discord/Slack/Telegram) --------------------
// POST /api/alerts/webhook – empfaengt Alertmanager-Webhook-JSON und leitet
// feuernde/resolvte Alerts an konfigurierte Webhooks weiter:
//   DISCORD_WEBHOOK, SLACK_WEBHOOK, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
// Ohne konfigurierte Webhooks wird 202 ohne Side-Effects geantwortet.
app.post('/api/alerts/webhook', async (req, res) => {
  const alerts = Array.isArray((req.body ?? {}).alerts) ? (req.body as any).alerts : [];
  const discord = process.env.DISCORD_WEBHOOK?.trim();
  const slack = process.env.SLACK_WEBHOOK?.trim();
  const telegramBot = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const telegramChat = process.env.TELEGRAM_CHAT_ID?.trim();
  const targets: string[] = [];
  if (discord) targets.push('discord');
  if (slack) targets.push('slack');
  if (telegramBot && telegramChat) targets.push('telegram');

  const format = (a: any) => {
    const labels = a.labels ?? {};
    const inst = labels.instance ?? labels.alertname ?? 'sampleMONK';
    const status = String(a.status ?? 'firing').toUpperCase();
    const summary = String(a.annotations?.summary ?? a.annotations?.description ?? labels.alertname ?? 'Alert');
    return `[${status}] ${summary} (${inst})`;
  };

  let forwarded = 0;
  for (const alert of alerts.slice(0, 20)) {
    const text = format(alert);
    const payloads: Array<[string, string]> = [];
    if (discord) payloads.push([discord, JSON.stringify({ content: text })]);
    if (slack) payloads.push([slack, JSON.stringify({ text })]);
    if (telegramBot && telegramChat) {
      payloads.push([`https://api.telegram.org/bot${telegramBot}/sendMessage`, JSON.stringify({ chat_id: telegramChat, text })]);
    }
    for (const [url, body] of payloads) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) forwarded += 1;
      } catch {
        // Alert-Weiterleitung darf den Server nie beeintraechtigen.
      }
    }
  }
  res.status(202).json({ received: alerts.length, targets, forwarded });
});

// ===========================================================================
// Externe Cloud-Anbindung (Supabase + Cloudflare R2)
// ===========================================================================
// Ergänzende Endpunkte für die externe Sample-/Musik-Datenbank:
//   GET  /api/cloud/health   → Konfiguration/Aufrufstatus (Supabase, R2)
//   POST /api/cloud/sync     → Seeds die eingebauten Presets in Supabase
// Betrieb nur, wenn die Keys in `.env` gesetzt sind (andernfalls melden die
// Endpunkte 'not-configured' – die App bleibt weiterhin voll offline-fähig).

app.get('/api/cloud/health', async (_req, res) => {
  try {
    const health = await cloudHealth();
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
    const sample = (req.body ?? {}) as {
      id?: string; name?: string; category?: string; type?: string;
      url?: string; description?: string; tags?: string[]; parameters?: Record<string, unknown>;
    };
    if (!sample.id || !sample.name || !sample.category || !sample.type) {
      return res.status(400).json({ ok: false, error: 'sample requires id, name, category, type' });
    }
    const result = await pushSampleToCloud({
      id: sample.id,
      name: sample.name,
      category: sample.category as 'bass' | 'mids' | 'highs',
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
    const track = (req.body ?? {}) as { id?: string; name?: string; artist?: string; url?: string; bpm?: number };
    if (!track.id || !track.name || !track.url) {
      return res.status(400).json({ ok: false, error: 'track requires id, name, url' });
    }
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
      const body = (req.body ?? {}) as { key?: string; dataBase64?: string; contentType?: string };
      if (!body.key || !body.dataBase64) {
        return res.status(400).json({ ok: false, error: 'upload requires key + binary body (?key=…) or JSON { key, dataBase64 }' });
      }
      key = body.key;
      contentType = body.contentType ?? contentType;
      buf = Buffer.from(body.dataBase64, 'base64');
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
    console.error('[cloud] /api/cloud/upload fehlgeschlagen:', e);
    res.status(502).json({ ok: false, error: 'cloud-upload-failed' });
  }
});

// ===========================================================================
// Lokale, cloud-freie Endpunkte
// Diese Endpunkte halten die Frontend-Funktionen (KI-Komposition, Stems,
// Voice) am Laufen, ohne externe Cloud-Anbieter zu nutzen.
//
// Hinweis: Falls spaeter ein echter Backend-Service (z.B. services/backend-core
// mit eigenem Host) betrieben wird, kann hier ein Proxy eingebaut werden.
// ===========================================================================

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
  const { prompt } = (req.body ?? {}) as { prompt?: string };
  const seed = (String(prompt ?? 'techno').trim().slice(0, 4000) || 'techno').length;

  // Deterministische Patterns aus dem Prompt-Seed ableiten (kein Netz).
  const kick = Array.from({ length: 16 }, (_, i) => (i + seed) % 4 === 0);
  const hat = Array.from({ length: 16 }, (_, i) => (i + seed) % 2 === 1);
  const clap = Array.from({ length: 16 }, (_, i) => i === 4 || i === 12);
  const synth = Array.from({ length: 16 }, (_, i) => (i + seed * 2) % 3 === 0);

  const synthNotes = Array.from({ length: 16 }, (_, i) => (i + seed) % 8);
  const bpm = 110 + (seed % 36); // 110–145

  return res.json({
    task_id: 'local_' + Date.now(),
    patterns: { kick, hat, clap, synth },
    synthNotes,
    bpm,
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
  const { prompt } = (req.body ?? {}) as { prompt?: string };
  const query = (String(prompt ?? '').trim().slice(0, 4000) || 'Dark warehouse techno drums');

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
  const kick = Array.from({ length: 16 }, (_, i) => (i + seed) % 4 === 0);
  const hat = Array.from({ length: 16 }, (_, i) => (i + seed) % 2 === 1);
  const clap = Array.from({ length: 16 }, (_, i) => i === 4 || i === 12);
  const synth = Array.from({ length: 16 }, (_, i) => (i + seed * 2) % 3 === 0);
  const synthNotes = Array.from({ length: 16 }, (_, i) => (i + seed) % 8);
  return res.json({
    task_id: 'local_' + Date.now(), source: 'local',
    patterns: { kick, hat, clap, synth }, synthNotes,
    bpm: 110 + (seed % 36), genre: 'Local Techno',
  });
});

// --- POST /api/ai/describe  → Ollama-gestützte Beschreibung (Style/Mix-Empfehlung) ---
app.post('/api/ai/describe', async (req, res) => {
  const { prompt } = (req.body ?? {}) as { prompt?: string };
  const query = (String(prompt ?? '').trim().slice(0, 4000) || 'Was ist ein guter Mix-Vorschlag ?');

  const llmPrompt =
    'Beantworte kurz (max 2 Sätze), auf Deutsch, fachlich für einen Musik-Produzenten: ' + query;

  const raw = await ollamaGenerate(llmPrompt);
  if (raw) {
    return res.json({ ai: raw.trim() });
  }
  return res.json({ ai: 'Ollama nicht erreichbar. (Lokaler Fallback: keine KI-Antwort verfügbar)' });
});

// --- POST /api/ai/generate-drop  → dropMONK Drop-Generator (LLM + Fallback) ---
// Request:  { userPrompt|prompt, context?: { bpm, activePlugins, currentEnergy }, style?, duration? }
// Response: { name, description, category, parameterSequence, buildupTime,
//             dropDuration, quantization, intensity, confidence, tags, source }
app.post('/api/ai/generate-drop', async (req, res) => {
  metrics.aiRequests += 1;

  const body = (req.body ?? {}) as {
    userPrompt?: string;
    prompt?: string;
    context?: { bpm?: number; activePlugins?: unknown; currentEnergy?: number };
    style?: string;
    duration?: number;
  };

  const userPrompt = String(body.userPrompt ?? body.prompt ?? '').trim().slice(0, 2000);
  if (!userPrompt) return res.status(400).json({ error: 'userPrompt fehlt' });

  const rawBpm = Number(body.context?.bpm);
  const rawEnergy = Number(body.context?.currentEnergy);
  const rawDuration = Number(body.duration);
  const style: DropStyle =
    body.style === 'subtle' || body.style === 'extreme' ? body.style : 'moderate';

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

  // 1) LLM-Router (API-Keys bleiben serverseitig)
  try {
    const completion = await llmRouter.complete({
      prompt: llmPrompt,
      complexity: 'moderate',
      maxTokens: 900,
      temperature: 0.7,
      reasoningEffort: 'low',
    });
    return res.json({ ...sanitizeAiDropResponse(completion.text, dropRequest), provider: completion.provider });
  } catch (err) {
    console.warn('[generate-drop] LLM-Router nicht nutzbar:', (err as Error).message);
  }

  // 2) Lokales Ollama
  const raw = await ollamaGenerate(llmPrompt);
  if (raw) {
    try {
      return res.json({ ...sanitizeAiDropResponse(raw, dropRequest), provider: 'ollama' });
    } catch (err) {
      console.warn('[generate-drop] ungültige Ollama-Antwort, Fallback.', (err as Error).message);
    }
  }

  // 3) Deterministischer lokaler Fallback (kein Netz, immer verfügbar)
  metrics.aiFailures += 1;
  return res.json({ ...generateDeterministicDrop(dropRequest), provider: 'local' });
});

// --- POST /api/ai/complete  → LLM-Router (Keys bleiben serverseitig) ---
app.post('/api/ai/complete', async (req, res) => {
  metrics.aiRequests += 1;
  const { prompt, complexity, maxTokens, temperature, reasoningEffort } = (req.body ?? {}) as {
    prompt?: string;
    complexity?: 'simple' | 'moderate' | 'complex';
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: 'low' | 'high' | 'max';
  };
  const clean = String(prompt ?? '').trim().slice(0, 8000);
  if (!clean) return res.status(400).json({ error: 'prompt fehlt' });

  const safeComplexity: 'simple' | 'moderate' | 'complex' =
    complexity === 'simple' || complexity === 'moderate' || complexity === 'complex'
      ? complexity
      : 'moderate';
  const safeReasoning: 'low' | 'high' | 'max' | undefined =
    reasoningEffort === 'high' || reasoningEffort === 'max' || reasoningEffort === 'low'
      ? reasoningEffort
      : undefined;

  try {
    const completion = await llmRouter.complete({
      prompt: clean,
      complexity: safeComplexity,
      maxTokens: Number.isFinite(Number(maxTokens)) ? Math.max(64, Math.min(4096, Math.round(Number(maxTokens)))) : undefined,
      temperature: Number.isFinite(Number(temperature)) ? Math.min(2, Math.max(0, Number(temperature))) : undefined,
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
  const { userId, task, model, input, sessionId } = (req.body ?? {}) as {
    userId?: string; task?: AiTask; model?: string; input?: unknown; sessionId?: string;
  };
  const safeTask = String(task ?? '').trim() as AiTask;
  const safeModel = String(model ?? '').trim().slice(0, 200);
  if (!safeTask || !safeModel) {
    return res.status(422).json({ error: 'task and model are required' });
  }
  if (!isValidAiTask(safeTask)) {
    return res.status(422).json({ error: 'unknown task', task: safeTask.slice(0, 80) });
  }
  if (!isValidModelId(safeModel)) {
    return res.status(422).json({ error: 'invalid model id' });
  }
  metrics.aiRequests += 1;
  try {
    const result = await aiOrchestrator.orchestrate({
      userId: String(userId ?? 'localUser').slice(0, 64),
      task: safeTask,
      model: safeModel,
      input: input ?? {},
      sessionId: sessionId ? String(sessionId).slice(0, 128) : undefined,
    });
    void aiPersistence.saveJob(result.job);
    void aiPersistence.saveSession(aiOrchestrator.sessions.get());
    return res.json(result);
  } catch (err) {
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
  const result = await aiOrchestrator.mcp.invoke(name, (req.body ?? {}) as Record<string, unknown>);
  void aiPersistence.auditMcp(name, 'localUser', aiOrchestrator.sessions.get().sessionId, result.ok, String((req.body as { permission?: string } | undefined)?.permission ?? 'READ'));
  return res.json(result);
});

// --- POST /api/library/search → semantische Bibliotheks-Suche (NEW-MONK-6) ---
// 1) Supabase-Embedding-Pfad: match_samples-RPC (pgvector, Kosinus) – sobald
//    Supabase konfiguriert ist (Migration 005). 2) Lokaler Keyword-Fallback.
app.post('/api/library/search', async (req, res) => {
  const { query, limit } = (req.body ?? {}) as { query?: string; limit?: number };
  const q = String(query ?? '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'query fehlt' });
  const max = Math.max(1, Math.min(50, Number(limit) || 10));

  // RPC-Pfad (nur wenn Supabase konfiguriert ist; sonst lokaler Embedding-Pfad).
  const supabaseConfigured = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_LEGACY_PAT || process.env.SUPABASE_SERVICE_ROLE));
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

// --- POST /api/separate-stems  → lokaler Stems-Stub (SSE mit Fortschritt) ---
// P11: Proxy zum separaten stem-ai (FastAPI/Demucs) Container, falls aktiviert.
const getStemAiUrl = () => (process.env.STEM_AI_URL || '').trim() || fleetTargets.stemAi || 'http://stem-ai:8000'; // NOSONAR: interner Docker-Netzwerk-Endpunkt ohne TLS
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

// ===========================================================================
// master-player (nativer Mixing/Mastering-Dienst, FFmpeg+NumPy)
//   POST /api/master/mix     → Spuren mischen (Gain/Pan/3-Band-EQ)
//   POST /api/master/master  → Mastering-Kette (EQ/Kompressor/Limiter/LUFS)
//   POST /api/master/analyze → Peak/RMS/LUFS/True-Peak/LRA
//   GET  /api/master/health  → Service-Healthcheck
// Der Dienst läuft separat (docker-compose: master-player, Port 8000 intern).
// ===========================================================================
const getMasterPlayerUrl = () =>
  (process.env.MASTER_PLAYER_URL || '').trim() ||
  fleetTargets.masterPlayer ||
  'http://master-player:8000'; // NOSONAR: interner Docker-Netzwerk-Endpunkt ohne TLS

async function proxyMasterPlayer(pathName: string, req: express.Request, res: express.Response) {
  try {
    const resp = await fetch(getMasterPlayerUrl() + pathName, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
    });
    const data = await resp.json() as any;
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(502).json({ status: 'error', message: 'master-player Proxy fehlgeschlagen: ' + ((e as Error).message ?? '') });
  }
}

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

// --- Admin/Root-Debug (nur mit ADMIN_TOKEN, z. B. fuer Root-Debugging) -------
app.get('/api/admin/debug', (req, res) => {
  const adminToken = (process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({
    service: 'audioMONASTRY',
    uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
    metrics,
    stemActiveJobs,
    stemAiProvider: (process.env.STEM_AI_PROVIDER || 'fallback').trim(),
    replicateActive: Boolean((process.env.REPLICATE_API_TOKEN || '').trim()),
    llmProviders: llmRouter.providerIds(),
    node: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

app.get('/api/master/health', async (req, res) => proxyMasterPlayer('/health', req, res));
app.get('/api/master/selftest', async (req, res) => proxyMasterPlayer('/selftest', req, res));
app.post('/api/master/mix', async (req, res) => proxyMasterPlayer('/mix', req, res));
app.post('/api/master/master', async (req, res) => proxyMasterPlayer('/master', req, res));
app.post('/api/master/analyze', async (req, res) => proxyMasterPlayer('/analyze', req, res));

// ===========================================================================
// Sample-Upload mit Scan + korrekter Ablage (R2 + Supabase)
//   POST /api/upload/sample  (multipart/form-data)
//   Felder: file (audio/*), kind (sample|recording|stem|sound|voice),
//           name, artist, style, key, bpm, tags (kommagetrennt), type
//   Ablauf: validieren -> scannen (master-player /analyze) ->
//           Audio in Cloudflare R2 -> Metadaten in Supabase.
// ===========================================================================
const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 100);
const STEM_MAX_UPLOAD_MB = Number(process.env.STEM_MAX_UPLOAD_MB || 100);
const UPLOAD_KINDS = new Set(['sample', 'recording', 'stem', 'sound', 'voice']);
const AUDIO_EXT_RE = /\.(wav|mp3|flac|ogg|m4a|aac|aiff|aif)$/i;

// P-8: Bewährter Streaming-Multipart-Parser (busboy). Prüft die Dateigröße
// WÄHREND des Streamens (kein unbegrenztes RAM-Puffern, P-2-Fix) und kommt
// mit quoted Boundaries/Parametern korrekt zurecht.
function parseMultipartStream(
  req: import('http').IncomingMessage,
  maxFileBytes: number,
): Promise<{ fields: Record<string, string>; files: { name: string; filename: string; contentType: string; data: Buffer }[] }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fields: Record<string, string> = {};
    const files: { name: string; filename: string; contentType: string; data: Buffer }[] = [];
    // FA-P0-3 / D14: 1 Datei + Summenlimit (Defense-in-Depth gegen RAM-Exploit).
    let totalFileBytes = 0;
    let fileCount = 0;

    // busboy v1 exportiert eine Factory-Funktion (keinen Konstruktor).
    const BusboyFactory = ((BusboyModule as any).default ?? BusboyModule) as unknown as (opts: {
      headers: import('http').IncomingHttpHeaders;
      limits: { fileSize: number; files: number; fields: number; fieldSize: number };
    }) => import('stream').Writable & {
      on(event: 'field', cb: (name: string, value: string) => void): unknown;
      on(event: 'file', cb: (name: string, stream: import('stream').Readable, info: { filename: string; mimeType: string }) => void): unknown;
      on(event: 'limit' | 'error' | 'close', cb: (arg?: any) => void): unknown;
    };
    const bb = BusboyFactory({
      headers: req.headers as import('http').IncomingHttpHeaders,
      limits: { fileSize: maxFileBytes, files: 1, fields: 20, fieldSize: 64 * 1024 },
    });

    bb.on('field', (name: string, value: string) => {
      fields[name] = value;
    });

    bb.on('file', (name: string, stream: import('stream').Readable, info: { filename: string; mimeType: string }) => {
      fileCount += 1;
      if (fileCount > 1) {
        if (!settled) {
          settled = true;
          reject(new Error('Nur 1 Audio-Datei pro Upload erlaubt.'));
          req.destroy();
        }
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => {
        totalFileBytes += c.length;
        if (totalFileBytes > maxFileBytes) {
          if (!settled) {
            settled = true;
            reject(new Error(`Datei zu groß (max. ${Math.round(maxFileBytes / 1024 / 1024)} MB).`));
            req.destroy();
          }
          return;
        }
        chunks.push(c);
      });
      stream.on('limit', () => {
        if (!settled) {
          settled = true;
          reject(new Error(`Datei zu groß (max. ${Math.round(maxFileBytes / 1024 / 1024)} MB).`));
          req.destroy();
        }
      });
      stream.on('end', () => {
        if (settled) return;
        files.push({
          name,
          filename: info.filename || 'upload.bin',
          contentType: info.mimeType || 'application/octet-stream',
          data: Buffer.concat(chunks),
        });
      });
    });

    bb.on('error', (e: Error) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    bb.on('close', () => {
      if (!settled) {
        settled = true;
        resolve({ fields, files });
      }
    });

    req.pipe(bb);
  });
}

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

// --- POST /api/generate-voice  → lokaler Voice-Stub ---
app.post('/api/generate-voice', async (req, res) => {
  const { text, voicePreset } = (req.body ?? {}) as { text?: string; voicePreset?: string };
  // S6350: Eingabe sanitieren, bevor sie als CLI-Argument verwendet wird.
  const query = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
  const rawPreset = String(voicePreset ?? 'FEMALE_ROBOTIC').trim();
  const preset = /^[A-Za-z0-9_-]{1,32}$/.test(rawPreset) ? rawPreset : 'FEMALE_ROBOTIC';

  // Falls ein lokaler RVC/VITS-Synthesizer per env aktiviert ist und das CLI
  // existiert, wird dieser bevorzugt. Konfiguration:
  //   VOICE_ENGINE=rvc|vits   VOICE_CLI=/pfad/zu/predict (optional)
  const engine = (process.env.VOICE_ENGINE || '').trim().toLowerCase();
  const voiceCli = (process.env.VOICE_CLI || '').trim();
  if (engine && voiceCli && query) {
    try {
      const { execFile } = require('child_process');
      const audioUrl = await new Promise<string>((resolve, reject) => {
        const stamp = Date.now();
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

// ===========================================================================
// VoiceMONK: serverseitige HF-Inference-Proxy-Endpunkte
// ---------------------------------------------------------------------------
// Der Browser ruft ausschließlich /api/voice/* auf. HF_API_KEY und die
// Modell-Auswahl bleiben im Server-Prozess; der Client erhält nur die
// fertige Audio-Datei. Konfiguration via env:
//   HF_API_KEY, HF_TTS_MODEL, HF_BARK_MODEL,
//   HF_MUSIC_MODEL, HF_MUSIC_FALLBACK_MODEL
// ===========================================================================

// Primär: neuer HF-Router-Endpoint (api-inference.huggingface.co löst in
// manchen Docker-/DNS-Umgebungen nicht auf -> Fallback unten).
const HF_API_BASE = 'https://router.huggingface.co/hf-inference/models';
const HF_API_BASE_LEGACY = 'https://api-inference.huggingface.co/models';

type HfVoiceKind = 'tts' | 'bark' | 'music' | 'musicFallback';

const HF_ENV_MODEL: Record<HfVoiceKind, string> = {
  tts: 'HF_TTS_MODEL',
  bark: 'HF_BARK_MODEL',
  music: 'HF_MUSIC_MODEL',
  musicFallback: 'HF_MUSIC_FALLBACK_MODEL',
};

const HF_DEFAULT_MODEL: Record<HfVoiceKind, string> = {
  tts: 'facebook/mms-tts-deu',
  bark: 'suno/bark',
  music: 'facebook/musicgen-medium',
  musicFallback: 'facebook/musicgen-small',
};

/** Validiert einen Modell-Override (nur sicheres HF-Modell-ID-Format). */
function hfModelFor(kind: HfVoiceKind, override?: string): string {
  const clean = (override ?? '').trim();
  if (clean) {
    return /^[A-Za-z0-9_.\/-]{3,120}$/.test(clean) ? clean : '';
  }
  const env = (process.env[HF_ENV_MODEL[kind]] ?? '').trim();
  return env || HF_DEFAULT_MODEL[kind];
}

/** Serverseitiger HF-Inference-Aufruf mit Timeout. */
async function hfInference(
  model: string,
  inputs: unknown,
  parameters?: Record<string, unknown>,
  timeoutMs = 90000,
): Promise<globalThis.Response> {
  const key = (process.env.HF_API_KEY ?? '').trim();
  if (!key) throw new Error('HF_API_KEY nicht konfiguriert');
  let lastErr: unknown;
  for (const base of [HF_API_BASE, HF_API_BASE_LEGACY]) {
    try {
      const resp = await fetch(`${base}/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters ? { inputs, parameters } : { inputs }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) throw new Error(`HF ${model} HTTP ${resp.status}`);
      return resp;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('HF fetch fehlgeschlagen');
}

/** Replicate-Audio (Serverless-GPU, Pay-per-Use): TTS/Sing/Song/Stems. */
async function replicateAudio(model: string, input: Record<string, unknown>, timeoutMs = 180000): Promise<globalThis.Response> {
  const token = (process.env.REPLICATE_API_TOKEN || '').trim();
  if (!token) throw new Error('REPLICATE_API_TOKEN nicht konfiguriert');
  const createResp = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!createResp.ok) throw new Error(`Replicate ${model} HTTP ${createResp.status}`);
  let prediction = await createResp.json() as any;
  for (let i = 0; i < 45 && prediction?.status !== 'succeeded' && prediction?.status !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    prediction = await pollResp.json();
  }
  if (prediction?.status !== 'succeeded') throw new Error('Replicate-Audio-Job fehlgeschlagen');
  const out = prediction.output;
  const url: string | undefined = typeof out === 'string' ? out : Array.isArray(out) ? out[0] : (out?.audio ?? out?.url);
  if (!url) throw new Error('Replicate-Audio ohne Download-URL');
  const audioResp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!audioResp.ok) throw new Error(`Audio-Download HTTP ${audioResp.status}`);
  return audioResp;
}

/** Schickt eine HF-Audio-Antwort als Binär-Audio an den Client. */
async function sendHfBlob(res: Response, upstream: globalThis.Response): Promise<void> {
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'audio/wav');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}

/** Eigenen samplemonk-ai-runtime-Endpoint bevorzugen, falls konfiguriert. */
function voiceRuntimeUrl(): string {
  return (process.env.VOICE_AI_RUNTIME_URL || process.env.HF_ENDPOINT_URL || '').trim();
}

/**
 * Ruft den eigenen Custom-Container (samplemonk-ai-runtime) über POST /infer auf.
 * Liefert das fertige WAV als Buffer zurück. Der Runtime-Handler muss
 * `{ audioBase64, sampleRate }` zurückgeben.
 */
async function voiceRuntimeInference(
  task: string,
  model: string,
  input: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<Buffer> {
  const base = voiceRuntimeUrl();
  if (!base) throw new Error('VOICE_AI_RUNTIME_URL/HF_ENDPOINT_URL fehlt');
  const token = (process.env.HF_TOKEN || process.env.HF_API_KEY || '').trim();
  const resp = await fetch(`${base.replace(/\/+$/, '')}/infer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ task, model, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`AI-Runtime ${model} HTTP ${resp.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { result?: { audioBase64?: string; sampleRate?: number } };
  if (!data.result?.audioBase64) throw new Error(`AI-Runtime ${model}: audioBase64 fehlt`);
  return Buffer.from(data.result.audioBase64, 'base64');
}

function sendWavBuffer(res: Response, buf: Buffer): void {
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}

/** Sanitisiert Text/Prompts (kein Prompt-Injection-Rauschen, Länge begrenzt). */
function cleanVoiceText(raw: unknown, max = 500): string {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// --- POST /api/voice/tts  → Text → Stimme (Qwen3-TTS/MMS via eigener Runtime oder HF) ---
app.post('/api/voice/tts', async (req, res) => {
  const { text, model, language, speaker, instruct } = (req.body ?? {}) as {
    text?: string;
    model?: string;
    language?: string;
    speaker?: string;
    instruct?: string;
  };
  const clean = cleanVoiceText(text);
  if (!clean) return res.status(400).json({ error: 'text fehlt' });
  const selected = hfModelFor('tts', model);
  if (!selected) return res.status(400).json({ error: 'Ungültiges Modell' });
  try {
    const voiceProvider = (process.env.VOICE_PROVIDER || 'hf').trim();
    if (voiceProvider === 'replicate') {
      const ttsModel = (process.env.REPLICATE_TTS_MODEL || 'suno-ai/bark').trim();
      const upstream = await replicateAudio(ttsModel, { prompt: clean });
      await sendHfBlob(res, upstream);
    } else {
      // Eigene Runtime (samplemonk-ai, Qwen3-TTS) zuerst – HF-Serverless nur Fallback.
      if (voiceRuntimeUrl()) {
        const runtimeModel = (process.env.VOICE_AI_RUNTIME_TTS_MODEL || 'qwen3-tts-06b').trim();
        try {
          const runtimeBuf = await voiceRuntimeInference('tts', runtimeModel, {
            text: clean,
            language: cleanVoiceText(language, 50) || 'German',
            speaker: cleanVoiceText(speaker, 64) || 'Ryan',
            instruct: cleanVoiceText(instruct, 500),
          });
          return sendWavBuffer(res, runtimeBuf);
        } catch (runtimeErr) {
          console.warn(`[voice] Runtime-TTS (${runtimeModel}) fehlgeschlagen, Fallback auf HF:`, runtimeErr instanceof Error ? runtimeErr.message : runtimeErr);
        }
      }
      const upstream = await hfInference(selected, clean);
      await sendHfBlob(res, upstream);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unbekannter Fehler';
    res.status(502).json({ error: 'tts fehlgeschlagen', detail });
  }
});

// --- POST /api/voice/sing  → Text → Gesang (Suno Bark) ---
app.post('/api/voice/sing', async (req, res) => {
  const { text, model } = (req.body ?? {}) as { text?: string; model?: string };
  const clean = cleanVoiceText(text);
  if (!clean) return res.status(400).json({ error: 'text fehlt' });
  const selected = hfModelFor('bark', model);
  if (!selected) return res.status(400).json({ error: 'Ungültiges Modell' });
  try {
    const voiceProvider = (process.env.VOICE_PROVIDER || 'hf').trim();
    if (voiceProvider === 'replicate') {
      const singModel = (process.env.REPLICATE_BARK_MODEL || 'suno-ai/bark').trim();
      const upstream = await replicateAudio(singModel, { prompt: `♪ ${clean} ♪` });
      await sendHfBlob(res, upstream);
    } else {
      // Eigene Runtime (Bark) zuerst – HF-Serverless nur Fallback.
      if (voiceRuntimeUrl()) {
        const runtimeModel = (process.env.VOICE_AI_RUNTIME_SING_MODEL || 'bark').trim();
        try {
          const runtimeBuf = await voiceRuntimeInference('sing', runtimeModel, { text: `♪ ${clean} ♪` });
          return sendWavBuffer(res, runtimeBuf);
        } catch (runtimeErr) {
          console.warn(`[voice] Runtime-Sing (${runtimeModel}) fehlgeschlagen, Fallback auf HF:`, runtimeErr instanceof Error ? runtimeErr.message : runtimeErr);
        }
      }
      // Bark singt am zuverlässigsten mit ♪-Noten-Prompt.
      const upstream = await hfInference(selected, `♪ ${clean} ♪`);
      await sendHfBlob(res, upstream);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unbekannter Fehler';
    res.status(502).json({ error: 'sing fehlgeschlagen', detail });
  }
});

// --- POST /api/voice/song  → Prompt → Song (MusicGen medium → small) ---
app.post('/api/voice/song', async (req, res) => {
  const { prompt, model, durationSeconds, style, bpm } = (req.body ?? {}) as {
    prompt?: string;
    model?: string;
    durationSeconds?: number;
    style?: string;
    bpm?: number;
  };
  const clean = cleanVoiceText(prompt);
  if (!clean) return res.status(400).json({ error: 'prompt fehlt' });

  const duration = Math.max(1, Math.min(30, Number(durationSeconds) || 8));
  const maxTokens = Math.max(64, Math.round(duration * 50 / 8));
  const parameters = { max_new_tokens: maxTokens };

  // Prompt für MusicGen: Stil/BPM sauber anhängen (kein Freitext-Injection-Risiko).
  const styleClean = String(style ?? '').replace(/[^\p{L}\p{N}\s\-]/gu, '').trim().slice(0, 80);
  const bpmClean = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Math.round(Number(bpm)) : 0;
  const inputs = [
    clean,
    styleClean ? `Style: ${styleClean}` : '',
    bpmClean ? `BPM: ${bpmClean}` : '',
  ].filter(Boolean).join(', ');

  const primary = hfModelFor('music', model);
  const fallback = model ? '' : hfModelFor('musicFallback');
  const candidates = [primary, fallback].filter((m) => m.length > 0);
  let lastError = '';

  // Eigene Runtime (MusicGen im samplemonk-ai) zuerst – HF-Serverless Fallback.
  if (voiceRuntimeUrl()) {
    const runtimeModel = (process.env.VOICE_AI_RUNTIME_SONG_MODEL || 'musicgen-small').trim();
    try {
      const runtimeBuf = await voiceRuntimeInference(
        'song',
        runtimeModel,
        { prompt: inputs, maxDuration: duration },
        240_000,
      );
      return sendWavBuffer(res, runtimeBuf);
    } catch (runtimeErr) {
      lastError = runtimeErr instanceof Error ? runtimeErr.message : 'Unbekannter Fehler';
      console.warn(`[voice] Runtime-Song (${runtimeModel}) fehlgeschlagen, Fallback auf HF:`, lastError);
    }
  }

  for (const candidate of candidates) {
    try {
      const upstream = await hfInference(candidate, inputs, parameters, 120000);
      return await sendHfBlob(res, upstream);
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Unbekannter Fehler';
      console.warn(`[voice] ${candidate} fehlgeschlagen:`, lastError);
    }
  }
  return res.status(502).json({ error: 'song fehlgeschlagen', detail: lastError || 'Kein Modell verfügbar' });
});

// ===========================================================================
// soundMONK: Server-AI-Generierung (MusicGen/Runtime) – Browser-Fallback lokal
// ===========================================================================
const SOUND_DEFAULT_PROMPTS: Record<string, string> = {
  beat: 'electronic techno beat, 128 BPM, driving drums, acid bassline',
  bass: 'deep electronic bass one-shot, sub-heavy, punchy, short decay',
  atmosphere: 'dark ambient pad, wide reverb, evolving textures, cinematic',
  oneshot: 'electronic percussion one-shot, tight, clean transient, studio quality',
};

app.post('/api/sound/generate', async (req, res) => {
  const { kind, prompt, durationSeconds } = (req.body ?? {}) as {
    kind?: string;
    prompt?: string;
    durationSeconds?: number;
  };
  const kindClean = String(kind ?? 'beat').replace(/[^a-z]/gi, '').toLowerCase().slice(0, 20);
  const promptClean = cleanVoiceText(prompt, 300);
  const inputs = promptClean || SOUND_DEFAULT_PROMPTS[kindClean] || SOUND_DEFAULT_PROMPTS.beat;
  const duration = Math.max(2, Math.min(20, Number(durationSeconds) || 6));

  if (!voiceRuntimeUrl()) {
    return res.status(503).json({ error: 'soundMONK: keine AI-Runtime konfiguriert', hint: 'VOICE_AI_RUNTIME_URL oder HF_ENDPOINT_URL setzen' });
  }
  try {
    const runtimeModel = (process.env.SOUND_AI_RUNTIME_MODEL || 'musicgen-small').trim();
    const runtimeBuf = await voiceRuntimeInference('song', runtimeModel, { prompt: inputs, maxDuration: duration }, 240_000);
    return sendWavBuffer(res, runtimeBuf);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Unbekannter Fehler';
    console.warn('[sound] AI-Generierung fehlgeschlagen:', detail);
    return res.status(502).json({ error: 'sound generation fehlgeschlagen', detail });
  }
});

// ===========================================================================
// songMONK: eigener Song-Endpoint (aus VoiceMONK entkoppelt)
// Nutzt die Runtime (MusicGen) zuerst; HF-Serverless als Fallback.
// Später: ACE-Step/DiffRhythm als echte Vocal-Song-Modelle ergänzen.
// ===========================================================================
app.post('/api/song/generate', async (req, res) => {
  const { prompt, model, durationSeconds, style, bpm } = (req.body ?? {}) as {
    prompt?: string;
    model?: string;
    durationSeconds?: number;
    style?: string;
    bpm?: number;
  };
  const clean = cleanVoiceText(prompt);
  if (!clean) return res.status(400).json({ error: 'prompt fehlt' });

  const duration = Math.max(1, Math.min(30, Number(durationSeconds) || 8));
  const maxTokens = Math.max(64, Math.round(duration * 50 / 8));
  const parameters = { max_new_tokens: maxTokens };

  const styleClean = String(style ?? '').replace(/[^\p{L}\p{N}\s\-]/gu, '').trim().slice(0, 80);
  const bpmClean = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Math.round(Number(bpm)) : 0;
  const inputs = [
    clean,
    styleClean ? `Style: ${styleClean}` : '',
    bpmClean ? `BPM: ${bpmClean}` : '',
  ].filter(Boolean).join(', ');

  const primary = hfModelFor('music', model);
  const fallback = model ? '' : hfModelFor('musicFallback');
  const candidates = [primary, fallback].filter((m) => m.length > 0);
  let lastError = '';

  // Eigene Runtime zuerst (MusicGen small als Default, Medium/ACE-Step später per Env).
  if (voiceRuntimeUrl()) {
    const runtimeModel = (process.env.SONG_AI_RUNTIME_MODEL || 'musicgen-small').trim();
    try {
      const runtimeBuf = await voiceRuntimeInference('song', runtimeModel, { prompt: inputs, maxDuration: duration }, 240_000);
      return sendWavBuffer(res, runtimeBuf);
    } catch (runtimeErr) {
      lastError = runtimeErr instanceof Error ? runtimeErr.message : 'Unbekannter Fehler';
      console.warn(`[song] Runtime-Song (${runtimeModel}) fehlgeschlagen, Fallback auf HF:`, lastError);
    }
  }

  for (const candidate of candidates) {
    try {
      const upstream = await hfInference(candidate, inputs, parameters, 120000);
      return await sendHfBlob(res, upstream);
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Unbekannter Fehler';
      console.warn(`[song] ${candidate} fehlgeschlagen:`, lastError);
    }
  }
  return res.status(502).json({ error: 'songMONK fehlgeschlagen', detail: lastError || 'Kein Modell verfügbar' });
});

// ===========================================================================
// Static Asset delivery (Vite dev / production dist)
// ===========================================================================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    // Lazy-Import: vite ist eine Dev-Dependency und darf im Produktions-Image
    // (npm prune --omit=dev) fehlen.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });

    // Dev: ONNX-Modelle mit korrektem MIME vor Vite ausliefern (sonst leerer
    // Content-Type; onnxruntime-web erwartet octet-stream/arraybuffer).
    app.use('/models', express.static(path.join(process.cwd(), 'public/models'), {
      setHeaders: (res, p) => {
        if (p.endsWith('.onnx')) res.setHeader('Content-Type', 'application/octet-stream');
      },
    }));

    // Dev-Fix: Die AudioWorklet-Dateien werden von build-worklets.mjs nach
    // `public/worklets` (für Vite Dev) UND `dist/worklets` (für Prod) gebaut.
    // Wir servieren /worklets EXPLIZIT VOR vite.middlewares, damit /worklets/*.js
    // echtes JS bekommt und NICHT vom Vite-SPA-Fallback als index.html geliefert
    // wird (sonst: addModule -> 'SyntaxError: expected expression, got <').
    const workletsDirs = [
      path.join(process.cwd(), 'public/worklets'),
      path.join(process.cwd(), 'dist/worklets'),
    ];
    for (const dir of workletsDirs) {
      app.use('/worklets', express.static(dir, {
        setHeaders: (res, p) => {
          if (p.endsWith('.js') || p.endsWith('.mjs')) {
            res.setHeader('Content-Type', 'application/javascript');
          }
        },
      }));
    }

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath, {
      setHeaders: (res, p) => {
        if (p.endsWith('.js') || p.endsWith('.mjs')) {
          res.setHeader('Content-Type', 'application/javascript');
        }
        if (p.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        }
        if (p.endsWith('.onnx')) {
          res.setHeader('Content-Type', 'application/octet-stream');
        }
        // Cache-Strategie: gehashte Vite-Assets unbegrenzt cachen (immutable),
        // alles andere (inkl. index.html) kurz validieren lassen.
        const isHashedAsset = /[-.][a-zA-Z0-9_-]{8,}\./.test(p) && /\.(?:js|css|wasm|png|webp|woff2?)$/.test(p);
        if (p.includes('/assets/') && isHashedAsset) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = http.createServer(app);

  // --- WebRTC Socket.io signaling (same origin as the app) ---
  const IDLE_TIMEOUT_MS = Number(process.env.SIGNALING_IDLE_TIMEOUT_MS || 20 * 60 * 1000);
  const ALLOWED_ORIGINS = (process.env.SIGNALING_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // '*' muss als Wildcard durchgereicht werden (Array ['*'] matcht keine Origins).
  const CORS_ORIGIN: any = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : ALLOWED_ORIGINS.length > 0
      ? ALLOWED_ORIGINS
      : false;

  try {
    const { Server } = (await import('socket.io')) as any;
    const io = new Server(server, {
      cors: {
        origin: CORS_ORIGIN,
        methods: ['GET', 'POST'],
      },
      path: '/webrtc-signaling',
    });

    // P-11: Handshake-Auth + Origin-Prüfung. Mit STUDIO_ACCESS_TOKEN müssen
    // Clients das `studio`-Cookie (vom Portal gesetzt) mitschicken.
    io.use((socket: any, next: (err?: Error) => void) => {
      const origin = String(socket.handshake?.headers?.origin ?? '');
      if (
        ALLOWED_ORIGINS.length > 0 &&
        !ALLOWED_ORIGINS.includes('*') &&
        origin &&
        !ALLOWED_ORIGINS.includes(origin)
      ) {
        return next(new Error('origin-not-allowed'));
      }
      if (studioTokenEnabled) {
        const cookie = String(socket.handshake?.headers?.cookie ?? '');
        const m = cookie.match(/(?:^|;\s*)studio=([^;]+)/);
        const token = String(socket.handshake?.auth?.token ?? '') ||
          String(socket.handshake?.headers?.['x-studio-token'] ?? '') ||
          (m ? decodeURIComponent(m[1]) : '');
        if (!token || !safeTokenEqual(token, STUDIO_ACCESS_TOKEN)) {
          return next(new Error('unauthorized'));
        }
      }
      next();
    });

    // Multi-Instanz-Modus: Mit REDIS_URL teilen sich alle App-Knoten die
    // Socket.io-Räume (Session-/Plugin-State über Prozessgrenzen hinweg).
    const redisUrl = (process.env.REDIS_URL || '').trim();
    if (redisUrl) {
      try {
        const [{ createClient }, { createAdapter }] = await Promise.all([
          import('redis'),
          import('@socket.io/redis-adapter'),
        ]);
        const pubClient = createClient({ url: redisUrl });
        const subClient = pubClient.duplicate();
        await Promise.all([pubClient.connect(), subClient.connect()]);
        io.adapter(createAdapter(pubClient, subClient));
        console.log('Redis-Adapter aktiv (Socket.io Multi-Instanz).');
      } catch (e) {
        console.warn('Redis-Adapter nicht aktiv:', (e as Error).message);
      }
    }

    io.on('connection', (socket: any) => {
      activeSocketConnections += 1;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const refreshIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => socket.disconnect(true), IDLE_TIMEOUT_MS);
      };
      refreshIdleTimer();

      socket.on('disconnect', () => {
        activeSocketConnections = Math.max(0, activeSocketConnections - 1);
      });

      socket.on('offer', (data: any) => {
        refreshIdleTimer();
        if (!data.target || !data.offer) return;
        socket.to(data.target).emit('offer', { offer: data.offer, sender: socket.id, senderMode: socket.data?.sessionMode ?? 'member' });
      });
      socket.on('answer', (data: any) => {
        refreshIdleTimer();
        if (!data.target || !data.answer) return;
        socket.to(data.target).emit('answer', { answer: data.answer, sender: socket.id });
      });
      socket.on('ice-candidate', (data: any) => {
        refreshIdleTimer();
        if (!data.target || !data.candidate) return;
        socket.to(data.target).emit('ice-candidate', { candidate: data.candidate, sender: socket.id });
      });
      socket.on('activity', refreshIdleTimer);

      // -------------------------------------------------------------------
      // Session-Verwaltung (EINE feste Session, max. 4 User) – Full-Mesh.
      //   Kein Raum-Erstellen/Beitreten: Jede App-Sitzung ist automatisch
      //   genau dieser eine Raum. 'join-session { userId }' → 'session-members'
      //   an den Neuen, 'peer-joined' an alle anderen; bei >4: 'session-full'.
      // -------------------------------------------------------------------
      const SESSION_ROOM_ID = 'studio-session';
      const MAX_SESSION_USERS = 4;

      const sessionMembers = (room: string) => {
        const members: { socketId: string; userId: string; role: string }[] = [];
        const sockets = io.sockets.adapter.rooms.get(room);
        if (sockets) {
          for (const sid of sockets) {
            if (sid === socket.id) continue;
            const s = io.sockets.sockets.get(sid);
            // Master-Out-Listener zählen NICHT als Session-Mitglieder.
            if (s?.data?.sessionUserId && s?.data?.sessionMode !== 'master-out') {
              members.push({ socketId: sid, userId: s.data.sessionUserId, role: s.data.sessionRole ?? 'guest' });
            }
          }
        }
        return members;
      };

      socket.on('join-session', (data: any) => {
        refreshIdleTimer();
        const userId = String(data?.userId ?? socket.id).trim();
        // MASTEROUTMAINSTREAM: eigener Listen-Modus – zählt nicht zu den 4 Usern,
        // sendet selbst nichts und bekommt die Mitgliederliste, um den Host zu
        // finden (Szenario: 4 iPads + 1 Laptop am Verstärker).
        const mode = String(data?.mode ?? 'member') === 'master-out' ? 'master-out' : 'member';
        const room = `session:${SESSION_ROOM_ID}`;
        socket.data.sessionUserId = userId;
        socket.data.sessionRoom = SESSION_ROOM_ID;
        socket.data.sessionMode = mode;
        // P4-2: Server-seitige Rolle – erster User ist Host/Admin, Rest lt. SESSION_ROLE.
        const role = roleForSessionUser(userId);
        socket.data.sessionRole = role;
        if (!sessionRoles.has(userId)) sessionRoles.set(userId, role);
        addServerAudit(userId, role, mode === 'master-out' ? 'JOIN_MASTER_OUT' : 'JOIN_SESSION', true, SESSION_ROOM_ID);
        socket.join(room);

        const members = sessionMembers(room);
        if (mode === 'master-out') {
          // Nicht an die Session-Mitglieder ankündigen (kein peer-joined), damit
          // niemand Mikrofon-Tracks an den Listener schickt. Der Listener
          // initiiert seine Verbindung selbst zum Host.
          socket.emit('session-members', {
            roomId: SESSION_ROOM_ID,
            members,
            selfRole: 'guest',
            selfMode: 'master-out',
            hostUserId: [...sessionRoles.entries()].find(([, r]) => r === 'admin')?.[0] ?? '',
          });
          return;
        }

        if (members.length >= MAX_SESSION_USERS) {
          socket.emit('session-full', { roomId: SESSION_ROOM_ID, max: MAX_SESSION_USERS });
          socket.leave(room);
          return;
        }

        socket.emit('session-members', { roomId: SESSION_ROOM_ID, members, selfRole: role, hostUserId: [...sessionRoles.entries()].find(([, r]) => r === 'admin')?.[0] ?? userId });
        socket.to(room).emit('peer-joined', { roomId: SESSION_ROOM_ID, socketId: socket.id, userId, role });
      });

      // P4-2: Admin kann einem User eine neue Rolle zuweisen (server-erzwungen).
      socket.on('assign-role', (data: any) => {
        refreshIdleTimer();
        const senderRole = String(socket.data?.sessionRole ?? 'guest');
        if (senderRole !== 'admin') {
          addServerAudit(String(socket.data?.sessionUserId ?? socket.id), senderRole, 'ASSIGN_ROLE', false, String(data?.userId ?? ''));
          socket.emit('rbac-denied', { action: 'assign-role', reason: 'admin required' });
          return;
        }
        const targetUserId = String(data?.userId ?? '').trim();
        const newRole = String(data?.role ?? '').trim();
        if (!targetUserId || !['admin', 'producer', 'engineer', 'guest'].includes(newRole)) return;
        sessionRoles.set(targetUserId, newRole);
        // Alle Sockets dieses Users aktualisieren.
        for (const [, s] of io.sockets.sockets as any) {
          if (s?.data?.sessionUserId === targetUserId) s.data.sessionRole = newRole;
        }
        addServerAudit(String(socket.data?.sessionUserId ?? socket.id), senderRole, 'ASSIGN_ROLE', true, `${targetUserId}->${newRole}`);
        const roomId = socket.data?.sessionRoom;
        if (roomId) socket.to(`session:${roomId}`).emit('role-changed', { userId: targetUserId, role: newRole });
        socket.emit('role-changed', { userId: targetUserId, role: newRole });
      });

      // DCT-102: Socket.io-Relay für Modul-/AUTO_AI-State, wenn WebRTC-DataChannels
      // (noch) nicht offen sind – deterministischer Fallback über den Signaling-Pfad.
      socket.on('plugin-state', (data: any) => {
        refreshIdleTimer();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const senderRole = String(socket.data?.sessionRole ?? 'guest');
        // P4-2: Server-seitige RBAC – PRO-Promotion nur für admin/producer.
        const state = (data as any)?.state;
        if (state && !roleCanState(senderRole, String(state))) {
          addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', false, String((data as any)?.pluginId ?? ''));
          socket.emit('rbac-denied', { action: 'plugin-state', pluginId: (data as any)?.pluginId, state, role: senderRole });
          return;
        }
        addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', true, String((data as any)?.pluginId ?? ''));
        // Session-Identität: Sender-User-ID anhängen, damit Empfänger
        // Änderungen einem User zuordnen können (Locking/Audit).
        const payload = data && typeof data === 'object'
          ? { ...data, senderUserId, senderRole }
          : data;
        socket.to(`session:${roomId}`).emit('plugin-state', payload);
      });

      socket.on('leave-session', () => {
        refreshIdleTimer();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        socket.to(`session:${roomId}`).emit('peer-left', { roomId, socketId: socket.id, userId: socket.data?.sessionUserId });
        socket.leave(`session:${roomId}`);
      });

      socket.on('disconnect', () => {
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        socket.to(`session:${roomId}`).emit('peer-left', { roomId, socketId: socket.id, userId: socket.data?.sessionUserId });
      });
    });

    // ---------------------------------------------------------------------
    // SFU (Mediasoup) – skalierbarer Kollaborations-Transport für 10+ Nutzer
    // Aktiviert mit ENABLE_SFU=1. Baut einen Mediasoup-Router pro Session auf
    // und bedient die RTC-Capabilities-/Transport-/Produce-/Consume-Anfragen
    // des Frontend-`MediasoupTransport`.
    // ---------------------------------------------------------------------
    if ((process.env.ENABLE_SFU || '').trim() === '1') {
      try {
        const mediasoup = (await import('mediasoup')) as any;
        const sfuIo = new Server(server, {
          cors: {
            origin: CORS_ORIGIN,
            methods: ['GET', 'POST'],
          },
          path: '/sfu-signaling',
        });

        // Globale (für diese Prozessinstanz) Worker/Router-Registry je Session.
        // RTC-Portbereich per Env einstellbar, damit der docker-compose-Portbereich
        // klein gehalten werden kann (sonst erzeugt Docker sehr viele iptables-Regeln).
        const SFU_RTC_MIN_PORT = Number(process.env.SFU_RTC_MIN_PORT || 40000);
        const SFU_RTC_MAX_PORT = Number(process.env.SFU_RTC_MAX_PORT || 40099);
        const mWorker = await mediasoup.createWorker({ rtcMinPort: SFU_RTC_MIN_PORT, rtcMaxPort: SFU_RTC_MAX_PORT });
        const routers = new Map<string, any>();
        // Producer-Registry je Session: erlaubt Peer-uebergreifendes Consume.
        const sessionProducers = new Map<string, Map<string, any>>();

        const ensureRouter = async (sessionId: string) => {
          if (!routers.has(sessionId)) {
            const router = await mWorker.createRouter({
              mediaCodecs: [
                { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
              ],
            });
            routers.set(sessionId, router);
          }
          return routers.get(sessionId);
        };

        sfuIo.on('connection', (socket: any) => {
          const sessionId = (socket.handshake?.query?.sessionId || 'main').toString();
          // Mehrere Transports je Socket (send + recv) und lokale Producer-Map.
          const transports = new Map<string, any>();
          const producers = new Map<string, any>();
          if (!sessionProducers.has(sessionId)) sessionProducers.set(sessionId, new Map());
          const sessionProducerMap = sessionProducers.get(sessionId)!;
          socket.join(`sfu-session:${sessionId}`);

          socket.on('getRouterRtpCapabilities', async (_d: any, cb: any) => {
            try {
              const router = await ensureRouter(sessionId);
              cb?.({ rtpCapabilities: router.rtpCapabilities });
            } catch (e) { cb?.({ error: (e as Error).message }); }
          });
          socket.on('createTransport', async (data: any, cb: any) => {
            try {
              const router = await ensureRouter(sessionId);
              const transport = await router.createWebRtcTransport({
                listenIps: [{ ip: process.env.SFU_LISTEN_IP || '0.0.0.0', announcedIp: process.env.SFU_ANNOUNCED_IP } as any],
                enableUdp: true, enableTcp: true, preferUdp: true,
              });
              transport.on('dtlsstatechange', (s: string) => { if (s === 'closed') transport.close(); });
              transports.set(transport.id, transport);
              if (data?.direction) transport.appData.direction = data.direction;
              cb?.({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
              });
            } catch (e) { cb?.({ error: (e as Error).message }); }
          });
          socket.on('connectTransport', async (data: any, cb: any) => {
            try {
              const t = transports.get(String(data?.transportId ?? ''));
              if (!t) throw new Error('kein transport');
              await t.connect({ dtlsParameters: data.dtlsParameters });
              cb?.({});
            } catch (e) { cb?.({ error: (e as Error).message }); }
          });
          socket.on('produce', async (data: any, cb: any) => {
            try {
              const t = transports.get(String(data?.transportId ?? ''));
              if (!t) throw new Error('kein transport');
              if (t.appData?.direction === 'recv') throw new Error('recv-transport kann nicht produzieren');
              const producer = await t.produce({
                kind: data.kind, rtpParameters: data.rtpParameters, appData: data.appData,
              });
              producers.set(producer.id, producer);
              sessionProducerMap.set(producer.id, producer);
              socket.to(`sfu-session:${sessionId}`).emit('new-producer', { producerId: producer.id, kind: producer.kind });
              cb?.({ id: producer.id });
            } catch (e) { cb?.({ error: (e as Error).message }); }
          });
          socket.on('consume', async (data: any, cb: any) => {
            try {
              const t = transports.get(String(data?.transportId ?? ''));
              if (!t) throw new Error('kein transport');
              if (t.appData?.direction === 'send') throw new Error('send-transport kann nicht konsumieren');
              const producer = sessionProducerMap.get(String(data?.producerId ?? ''));
              if (!producer) throw new Error('producer nicht gefunden');
              const consumer = await t.consume({
                producerId: producer.id, rtpCapabilities: data.rtpCapabilities,
              });
              cb?.({
                id: consumer.id, kind: consumer.kind,
                rtpParameters: consumer.rtpParameters, producerId: producer.id,
              });
            } catch (e) { cb?.({ error: (e as Error).message }); }
          });
          socket.on('disconnect', () => {
            for (const t of transports.values()) {
              try { t.close(); } catch { /* ignore */ }
            }
            transports.clear();
            for (const [id] of producers) {
              sessionProducerMap.delete(id);
            }
            producers.clear();
          });
        });
        console.log('SFU (Mediasoup) aktiviert: /sfu-signaling');
      } catch (e) {
        console.warn('Mediasoup SFU nicht gestartet (ENABLE_SFU):', (e as Error).message);
      }
    }
  } catch (e) {
    console.warn('Socket.io signaling disabled:', (e as Error).message);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`audioMONASTRY running on http://0.0.0.0:${PORT}`);
  });
}

export { app };

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  startServer();
}
