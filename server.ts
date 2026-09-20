import express from 'express';
import * as BusboyModule from 'busboy';
import http from 'http';
import path from 'path';
import {
  createHash,
} from 'crypto';
import compression from 'compression';
import dotenv from 'dotenv';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
  uploadSampleToR2,
} from './server/cloud.ts';
import { resolveAiRateLimits } from './src/config/aiRateLimits';
// ARCH-P2-002: server.ts wird schrittweise zerlegt. Route-Gruppen liegen als
// Factories unter server/routes/ und werden an ihrer Originalposition
// registriert (Reihenfolge = Middleware-Reihenfolge, siehe app.use oben).
import { registerCloudRoutes } from './server/routes/cloudRoutes.ts';
import { registerSessionRoutes } from './server/routes/sessionRoutes.ts';
import { registerAiRoutes } from './server/routes/aiRoutes.ts';
import { registerMasterRoutes } from './server/routes/masterRoutes.ts';
import { registerVoiceRoutes } from './server/routes/voiceRoutes.ts';
// Der Stem-Job-Zaehler wird im Stem-Modul gefuehrt (dort schreibt ihn die Route);
// Ops- und Admin-Routen lesen ihn ueber diesen Getter - eine Wertkopie wuerde einfrieren.
import { registerStemRoutes, getStemActiveJobs } from './server/routes/stemRoutes.ts';
import { registerAdminRoutes } from './server/routes/adminRoutes.ts';
import { registerUploadRoutes } from './server/routes/uploadRoutes.ts';
import { registerOpsRoutes } from './server/routes/opsRoutes.ts';
import { registerAgentRoutes } from './server/routes/agentRoutes.ts';
import { ResumableAgentRunner } from './src/core/ai/agentRuns';
import { MoaAgent } from './src/core/ai/MoaAgent';
import { aiOrchestrator } from './src/core/ai/orchestrator/aiOrchestrator';
import { registerMediaRoutes } from './server/routes/mediaRoutes.ts';
import { createJsonBodyErrorHandler } from './server/httpBodyErrors.ts';
import { mosHarness } from './src/core/ai/orchestrator/mosHarness';
import { aiPersistence } from './src/core/ai/orchestrator/aiPersistence';
import { promptStore } from './src/core/ai/orchestrator/promptStore';
import { AuthoritativeSession } from './src/core/session/authoritativeSession';
import { looksLikeStudioSession, verifyStudioSession } from './src/core/session/studioSession';
import { resolveMainOutUserId } from './src/core/session/mainOutGuard';
import { LatencyHistogram } from './src/core/observability/latencyHistogram';
import { createSessionRuntime, DEFAULT_PLUGIN_LOCK_TTL_MS } from './server/sessionRuntime.ts';
import { createRealtimeHub, type RealtimeHub } from './server/realtime.ts';
import { createFleetWiring } from './server/fleetWiring.ts';
import { resolveRateLimitIdentity, SESSION_IDENTITY_HEADER } from './server/rateLimitKeys.ts';
import { buildCspPolicy, buildReportingHeaders, CSP_REPORT_PATH } from './server/csp.ts';
import { registerSecurityRoutes } from './server/routes/securityRoutes.ts';
import { VisualFrameHub, tokenFromUrl } from './server/visualStream.ts';
import { registerVisualRoutes } from './server/routes/visualRoutes.ts';
import { catalogFromMcpTools, createMcpAgentExecutor } from './server/mcpAgentExecutor.ts';

// DCT-101: Stem-Queue-Backpressure – harte Grenze für parallele Demucs-Jobs.
const STEM_MAX_JOBS = Math.max(1, Number(process.env.STEM_MAX_JOBS ?? 2));

/**
 * audioMONASTRY Server – VENDOR-/CLOUD-FREI.
 *
 * Diese Datei enthaelt KEINERLEI Verbindung zu externen Cloud-Anbietern.
 * Storage, Secret Manager oder GenAI. Der gesamte Stack (static
 * App + REST-API + WebRTC-Signaling) laeuft in einem Node-Prozess.
 *
 * Fuer Hetzner:  PORT=8080, NODE_ENV=production, `node dist/server.cjs`
 */

// ARCH-PERF-001: In Tests (VITEST=true / NODE_ENV=test) keine .env laden –
// sonst überschreibt dotenv die von den Tests kontrollierte Umgebung
// (z. B. STUDIO_ACCESS_TOKEN) und Server-Tests schlagen je nach Host-.env fehl.
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test' && process.env.AUDIOMONASTRY_NO_AUTOSTART !== '1') {
  dotenv.config();
}

const app = express();
// Enable COOP and COEP for cross‑origin isolation required by Mediasoup SFU
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
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
// ARCH-P2-002: Flotten-Verdrahtung (FLEET_MAP_URL, Ziel-Validierung, Altnamen-
// Fallback) liegt in server/fleetWiring.ts. `fleetTargets` wird bewusst als
// Getter weitergereicht: die Routen und der Ollama-/Master-Player-Zugriff lesen
// die Ziele zur Laufzeit, nicht als Kopie beim Start.
const fleetWiring = createFleetWiring({});
const fleetTargets = fleetWiring.targets;
void fleetWiring.wire();

// NOMEN-P1-001: fuer Tests und Aufrufer weiterhin direkt erreichbar.
export { fleetNodeAddress, buildFleetTarget } from './server/fleetWiring.ts';


// DCT-108: In-Process-Metriken (keine neuen Dependencies, keine Secrets/Samples).
const metrics = {
  requests: 0,
  errors: 0,
  latencyMsSum: 0,
  // PROD-P1-004: Histogramm zusaetzlich zum Mittelwert - nur damit ist ein
  // Latenz-SLO (p95) berechenbar; ein Mittelwert verdeckt den langen Schwanz.
  latencyHistogram: new LatencyHistogram(),
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

// P4-2: Server-seitiges Audit-Log (Rollenwechsel, Lock-/State-Events, RBAC-Denials).
const serverAuditLog: { ts: string; userId: string; role: string; action: string; target?: string; ok: boolean }[] = [];
const MAX_SERVER_AUDIT = 1000;
function addServerAudit(userId: string, role: string, action: string, ok: boolean, target?: string): void {
  serverAuditLog.push({ ts: new Date().toISOString(), userId, role, action, target, ok });
  if (serverAuditLog.length > MAX_SERVER_AUDIT) serverAuditLog.splice(0, serverAuditLog.length - MAX_SERVER_AUDIT);
}

// ROLLENSYSTEM ENTFERNT (2026-09-14): Kein admin/producer/engineer/guest mehr.
// Es gibt nur noch: Session-Mitglieder (equal) + der mixerMONK-Lock-Owner (DJ).
const MAIN_OUT_USER_ID = (process.env.MAIN_OUT_USER_ID || '').trim();
function resolveSessionMainOutUserId(): string {
  const lockOwner = sessionRuntime.session.lockOwner('mixer');
  if (lockOwner) return lockOwner;
  return resolveMainOutUserId(MAIN_OUT_USER_ID, []);
}
// COLLAB-P0-001: Serverautoritativer Session-State (Revision/Sequenz/Snapshot +
// atomare Locks) ersetzt die frühere rohe `pluginLocks`-Map. Der Client bleibt
// optimistisch; der Server verwirft verspätete/doppelte Events deterministisch.
const PLUGIN_LOCK_TTL_MS = DEFAULT_PLUGIN_LOCK_TTL_MS; // 60 s + Heartbeat-Verlängerung (Fallback)
/** Socket.io-Referenz für Modul-Scope-Routen (E2E-Reset); null vor Start. */
let serverIo: any = null;
/** Echtzeit-Schicht (ARCH-P2-002); null vor dem Start. */
let realtimeHub: RealtimeHub | null = null;

// ARCH-P2-002: Der autoritative Session-Zustand, seine Persistenz, die Snapshots
// (Prüfsumme/Retention, PERSIST-P1-003) und der Lock-Sweep liegen in
// server/sessionRuntime.ts. Hier bleibt nur die EINE Instanz - die Handler und
// Routen greifen ueber `sessionRuntime` darauf zu, statt den Zustand im
// Modulscope zu teilen.
const sessionRuntime = createSessionRuntime({
  log: (message) => console.log(message),
  checksum: (input: string) => createHash('sha256').update(input).digest('hex'),
});
sessionRuntime.start();

// DCT-108: Request/Trace-ID-Middleware (Korrelation User-Action → HTTP → AI).
app.use((req, res, next) => {
  const id = (req.headers['x-request-id'] as string) || `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader('X-Request-Id', id);
  metrics.lastRequestId = id;
  const start = Date.now();
  metrics.requests += 1;
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    metrics.latencyMsSum += durationMs;
    metrics.latencyHistogram.observe(durationMs);
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

// AI-P1-005: Body-Parse-Fehler strukturiert und ohne Stack-Trace beantworten.
// Muss DIREKT nach express.json() stehen, sonst greift der Express-Default-
// Handler und schreibt den kompletten Stack auf stderr.
app.use(createJsonBodyErrorHandler());

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
// F7-Fix: Die CSP wird jetzt aus der Umgebung ABGELEITET (server/csp.ts):
//   * kein pauschales `https:`/`wss:` mehr in `connect-src` (das erlaubte jedes
//     Ziel und machte die Policy unwirksam),
//   * `report-uri /api/security/csp-report` – vorher gab es KEIN Meldeziel, die
//     Report-Only-Policy meldete also ins Leere,
//   * `CSP_MODE=enforce` schaltet dieselbe Policy scharf (Default bleibt
//     `report-only`, siehe Begruendung in server/csp.ts).
const CSP_POLICY = buildCspPolicy(process.env as Record<string, string | undefined>);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader(CSP_POLICY.headerName, CSP_POLICY.value);
  for (const [name, value] of Object.entries(buildReportingHeaders())) res.setHeader(name, value);
  next();
});

// SEC-P2-002: Secret zum Prüfen der kurzlebigen Portal-Session-Token.
// Fehlt es, werden Session-Token abgelehnt (fail-closed) — der Master-Token
// funktioniert unverändert weiter.
const STUDIO_SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();

// --- Security: Rate limiting (per Env konfigurierbar fuer Lasttests) ---
const API_RATE_LIMIT_WINDOW_MS = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX || 60);
// AITodo Phase 18: explizite AI_RATE_*-Limits (Kostenbremse für KI-Routen).
const AI_RATE = resolveAiRateLimits(process.env as Record<string, string | undefined>);

// P-1: Studio-Zugangstoken. Wird vom Portal (Cloudflare Worker) gesetzt und
// als HttpOnly-Cookie `studio` an den Browser gegeben.
//   - Token gesetzt  → alle /api/* (außer health) + Socket.io-Handshake verlangen ihn.
//   - Token leer     → NUR mit explizitem Dev-/Test-Modus offen:
//       * NODE_ENV=production: immer geschlossen (fail-closed, 503)
//       * AUDIOMONASTRY_DEV_NO_AUTH=1 (nur außerhalb Production): lokaler Dev-Modus
//       * VITEST=true / NODE_ENV=test: Test-Modus
//     Ohne eine dieser Freigaben ist die API geschlossen (kein stiller Dev-Modus).
const STUDIO_ACCESS_TOKEN = (process.env.STUDIO_ACCESS_TOKEN || '').trim();
const studioTokenEnabled = STUDIO_ACCESS_TOKEN.length > 0;
// PROD-P0-001: Monitoring-Scrape. Ist SCRAPE_TOKEN gesetzt, sind die Lese-
// Metriken /api/metrics und /api/online fuer Prometheus mit x-scrape-token
// (oder Authorization: Bearer) erreichbar. Ohne SCRAPE_TOKEN bleibt alles
// unveraendert fail-closed ueber den Studio-Token.
const SCRAPE_TOKEN = (process.env.SCRAPE_TOKEN || '').trim();
const scrapeTokenEnabled = SCRAPE_TOKEN.length > 0;
// PROD-P1-004: Alertmanager ist ein Maschinen-Client und kann kein Studio-Cookie
// halten. Ohne diese Ausnahme starb JEDE Alarmzustellung mit 401
// (live belegt 2026-09-18: "unexpected status code 401 ... STUDIO_TOKEN_REQUIRED").
// Wie beim Scrape-Token gilt: nur diese eine Route, nur mit gueltigem Token,
// Konstantzeit-Vergleich - und ohne konfiguriertes Token bleibt alles fail-closed
// ueber die Studio-Auth.
const ALERT_WEBHOOK_TOKEN = (process.env.ALERT_WEBHOOK_TOKEN || '').trim();
const alertWebhookTokenEnabled = ALERT_WEBHOOK_TOKEN.length >= 16;
// P0-Security: Production läuft NIE ungeschützt. Fehlt der Studio-Token in
// Produktion, bleibt die API fail-closed (nur /api/health offen) statt fail-open.
const isProductionEnv = process.env.NODE_ENV === 'production';
const devNoAuthExplicit = process.env.AUDIOMONASTRY_DEV_NO_AUTH === '1' && !isProductionEnv;
const testNoAuth = !isProductionEnv && (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test');
const studioAuthOpen = !studioTokenEnabled && (devNoAuthExplicit || testNoAuth);
const studioTokenMissing = !studioTokenEnabled && !studioAuthOpen;
if (studioTokenMissing) {
  console.error('[security] FATAL: STUDIO_ACCESS_TOKEN fehlt und kein expliziter Dev-/Test-Modus aktiv. API ist bis auf /api/health geschlossen (fail-closed).');
} else if (studioAuthOpen) {
  console.warn('[security] Unauthentifizierter Modus aktiv (AUDIOMONASTRY_DEV_NO_AUTH=1 bzw. Test).');
}

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

// P0-Security: Produktions-Origin-Allowlist für die REST-API. Greift nur,
// wenn in Produktion explizit Origins konfiguriert sind (kein Breaking für
// lokale Dev-/Test-Umgebungen ohne Origin-Header).
const API_ALLOWED_ORIGINS = (
  process.env.API_ALLOWED_ORIGINS ||
  process.env.SIGNALING_ALLOWED_ORIGINS ||
  ''
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use('/api', (req, res, next) => {
  if (
    isProductionEnv &&
    API_ALLOWED_ORIGINS.length > 0 &&
    !API_ALLOWED_ORIGINS.includes('*')
  ) {
    const origin = String(req.headers?.origin ?? '');
    if (origin && !API_ALLOWED_ORIGINS.includes(origin)) {
      res.status(403).json({ error: 'origin-not-allowed', code: 'ORIGIN_NOT_ALLOWED' });
      return;
    }
  }
  next();
});

// P-1: Auth-Middleware für alle /api/* außer /api/health.
app.use('/api', async (req, res, next) => {
  if (req.path === '/health') return next();
  // VISION-Artefakte: das sind die vom Server selbst erzeugten Bilder/Clips/
  // Shows. Sie liegen bewusst token-frei wie /api/health — es ist dasselbe
  // öffentliche Material wie die R2-Public-URL (CFR2_PUBLIC_URL). Der Name
  // wird in der Route streng validiert (kein Pfadanteil, keine Liste).
  if (req.method === 'GET' && req.path.startsWith('/ai/vision/artifact/')) return next();
  // F7-Fix: CSP-Meldeweg. Der Browser sendet CSP-Reports OHNE eigene Header
  // (kein Cookie, kein Token moeglich) - mit Pflicht-Token waeren alle Meldungen
  // still verloren gegangen. Der Endpunkt ist rate-limitiert, nimmt nur wenige
  // hundert Bytes an, loggt nur Direktive + Host und antwortet immer 204.
  if (req.method === 'POST' && req.path === '/security/csp-report') return next();
  // PROD-P0-001: Scrape-Ausnahme nur fuer Lese-Metriken und nur mit gueltigem
  // Scrape-Token (konstantzeit-Vergleich). Ohne gueltiges Token laeuft die
  // Anfrage in die Studio-Auth weiter - nichts wird fail-open.
  // PROD-P1-004: Alarmzustellung (Alertmanager -> App -> Discord/Slack/Telegram).
  if (alertWebhookTokenEnabled && req.method === 'POST' && req.path === '/alerts/webhook') {
    const headerToken = String(req.headers?.['x-alert-token'] ?? '');
    const authHeader = String(req.headers?.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const presented = headerToken || bearerToken;
    if (presented && safeTokenEqual(presented, ALERT_WEBHOOK_TOKEN)) return next();
  }
  // VISUAL-P1-001: Der Beamer (Ghostuser 6) liest den MJPEG-Fallback mit einem
  // <img> - dort lassen sich KEINE Header setzen. Genau diese EINE Route darf den
  // Studio-Token deshalb als Query tragen (Vergleich weiterhin mit
  // safeTokenEqual). Alles andere bleibt bei Header/Cookie; ohne gueltiges Token
  // laeuft die Anfrage in die normale Auth und wird abgelehnt (kein fail-open).
  if (req.method === 'GET' && req.path === '/visual/mjpeg') {
    const queryToken = tokenFromUrl(req);
    if (queryToken && safeTokenEqual(queryToken, STUDIO_ACCESS_TOKEN)) return next();
  }
  if (
    scrapeTokenEnabled &&
    req.method === 'GET' &&
    (req.path === '/metrics' || req.path === '/online')
  ) {
    const headerToken = String(req.headers?.['x-scrape-token'] ?? '');
    const authHeader = String(req.headers?.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const scrape = headerToken || bearerToken;
    if (scrape && safeTokenEqual(scrape, SCRAPE_TOKEN)) return next();
  }
  // P0-Security: fail-closed – ohne Studio-Token UND ohne expliziten
  // Dev-/Test-Modus ist die API geschlossen (kein stiller Dev-Modus).
  if (studioTokenMissing) {
    res.status(503).json({ error: 'server not configured', code: 'STUDIO_TOKEN_MISSING' });
    return;
  }
  if (studioAuthOpen) return next();
  const token = studioTokenFromRequest(req);
  if (token && safeTokenEqual(token, STUDIO_ACCESS_TOKEN)) return next();
  // SEC-P2-002: Das Portal gibt dem Browser jetzt ein kurzlebiges, signiertes
  // Session-Token (`v1.<exp>.<hmac>`) statt des Master-Tokens. Additiv: der
  // Master-Token oben bleibt gültig (Skripte/CI/API-Clients/alte Cookies).
  // Ohne SESSION_SECRET auf dem Server ist diese Prüfung fail-closed.
  if (token && looksLikeStudioSession(token) && (await verifyStudioSession(token, STUDIO_SESSION_SECRET))) {
    return next();
  }
  res.status(401).json({ error: 'unauthorized', code: 'STUDIO_TOKEN_REQUIRED' });
});

/**
 * F5-Fix: Der Limiter-Schluessel ist NICHT mehr der Studio-Token selbst.
 *
 * Live belegt (2026-09-20, externe Instanz): mit dem Master-Token als Schluessel
 * teilten sich alle vier Browser-Nutzer, das Portal, die Monitoring-Skripte und
 * die Flotten-Aufrufe EIN Budget von 60/min (75 sequenzielle Aufrufe -> exakt
 * 60x200 + 15x429, `Retry-After: 56`). Die Identitaet kommt jetzt aus der
 * Nutzer-/Session-Ebene (signiertes Portal-Session-Token bzw. gemeldetes
 * `x-session-id`), sonst aus der IP – Details und Begruendung in
 * server/rateLimitKeys.ts.
 */
const studioKeyGenerator = (req: any): string =>
  resolveRateLimitIdentity(
    {
      token: studioTokenFromRequest(req),
      sessionId: req.headers?.[SESSION_IDENTITY_HEADER] ?? req.headers?.[String(SESSION_IDENTITY_HEADER)],
      ip: req.ip,
    },
    ipKeyGenerator,
  );

/** Health ist ein Monitoring-/Liveness-Endpunkt – nie unter einem Nutzer-Budget. */
const isHealthRequest = (req: { originalUrl?: string; url?: string }): boolean => {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return path === '/api/health';
};

/** Meldeweg der CSP (tokenfrei, siehe server/routes/securityRoutes.ts). */
const isCspReportRequest = (req: { method?: string; originalUrl?: string; url?: string }): boolean => {
  if (String(req.method || '').toUpperCase() !== 'POST') return false;
  return String(req.originalUrl || req.url || '').split('?')[0] === CSP_REPORT_PATH;
};

// FEAT-P3-003: Ein Chunk-Upload ist per Definition eine REQUEST-SERIE. Live
// belegt (2026-09-18): der allgemeine Limiter (60/min) und besonders der
// "expensiv"-Limiter (10/min) haben einen 5-MB-Upload nach 20 Chunks mit 429
// beendet - ein 100-MB-Upload haette nie durchlaufen koennen. Chunks sind
// ausserdem I/O (kein KI-/Cloud-Aufwand), die Kostenbremse gilt weiter fuer den
// Scan-/Ablage-Schritt. Deshalb: eigene Ausnahme vom allgemeinen Limit plus
// eigener Limiter mit eigenem Budget fuer die Chunk-Routen.
const isChunkUploadRequest = (req: { originalUrl?: string; url?: string }): boolean =>
  String(req.originalUrl || req.url || '').includes('/api/upload/chunk');

// AI-P1-006: Gleiche Ueberlegung fuer die Agent-Laeufe. Live belegt
// (2026-09-18): ein laufender Lauf wird vom Client regelmaessig abgefragt - das
// Status-LESEN landete hinter der Kostenbremse (10/min) und lief nach wenigen
// Polls in 429, obwohl es nichts kostet. Deshalb: eigener Limiter fuer die
// Agent-Routen; die teuren SCHREIB-Aufrufe (Lauf starten/fortsetzen) bleiben
// zusaetzlich unter der Kostenbremse.
const isAgentRequest = (req: { originalUrl?: string; url?: string }): boolean =>
  String(req.originalUrl || req.url || '').includes('/api/ai/agent/runs');
/** Lesender Zugriff auf einen Lauf: kostet nichts, darf nicht gebremst werden. */
const isAgentReadRequest = (req: { originalUrl?: string; url?: string; method?: string }): boolean =>
  String(req.method || '').toUpperCase() === 'GET' && isAgentRequest(req);

const AGENT_RATE_LIMIT_MAX = Number(process.env.AI_AGENT_RATE_LIMIT_MAX || 240);

const agentLimiter = rateLimit({
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  max: AGENT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many agent requests, please slow down.', code: 'AGENT_RATE_LIMIT' },
  keyGenerator: studioKeyGenerator,
});

const UPLOAD_CHUNK_RATE_LIMIT_MAX = Number(process.env.UPLOAD_CHUNK_RATE_LIMIT_MAX || 240);

// F5-Fix: /api/health lag bisher HINTER dem allgemeinen /api-Limiter und teilte
// sich damit das Nutzer-Budget. Live gemessen (2026-09-20): 30 parallele
// /api/health -> 300/300 HTTP 429, d. h. Monitoring und Alarmierung konnten
// durch normalen Studio-Betrieb mitgerissen werden (genau das Gegenteil dessen,
// was ein Health-Endpunkt leisten soll). Health hat jetzt einen EIGENEN,
// grosszuegigen Limiter pro IP (Default 600/min = 10/s) und ist aus dem
// allgemeinen Limiter ausgenommen. Die Bremse bleibt trotzdem: der Endpunkt ist
// tokenfrei und darf kein unbegrenzter Verstaerker sein.
const HEALTH_RATE_LIMIT_MAX = Number(process.env.HEALTH_RATE_LIMIT_MAX || 600);

const healthLimiter = rateLimit({
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  max: HEALTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many health requests, please slow down.', code: 'HEALTH_RATE_LIMIT' },
  // Monitoring (Prometheus/Alertmanager/Portal) haelt keinen Studio-Token:
  // Health wird deshalb bewusst pro IP gezaehlt, nicht pro Nutzer.
  keyGenerator: (req: any) => ipKeyGenerator(req.ip),
});

// Meldeweg der CSP: ebenfalls tokenfrei und deshalb mit eigenem, engem Budget,
// damit ein fehlerhaftes Deployment das Log nicht fluten kann.
const CSP_REPORT_RATE_LIMIT_MAX = Number(process.env.CSP_REPORT_RATE_LIMIT_MAX || 120);

const cspReportLimiter = rateLimit({
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  max: CSP_REPORT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reports, please slow down.', code: 'CSP_REPORT_RATE_LIMIT' },
  keyGenerator: (req: any) => ipKeyGenerator(req.ip),
});

const apiLimiter = rateLimit({
  windowMs: API_RATE_LIMIT_WINDOW_MS, // Standard: 1 Minute
  max: API_RATE_LIMIT_MAX, // Standard: 60 Requests/Minute je Session/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: studioKeyGenerator,
  // Eigene Budgets bleiben eigene Budgets: Chunks, Agent-Laeufe, Health und der
  // CSP-Meldeweg laufen NICHT unter dem allgemeinen Limit.
  skip: (req) =>
    isChunkUploadRequest(req) || isAgentRequest(req) || isHealthRequest(req) || isCspReportRequest(req),
});

// Chunk-Stream: eigenes, groesseres Budget (Default 240/min = 4 Chunks/s bei
// 4-MB-Chunks ~ 1 GB/min). Der Client wiederholt 429 mit Backoff.
const uploadChunkLimiter = rateLimit({
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  max: UPLOAD_CHUNK_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many upload chunks, please slow down.', code: 'UPLOAD_CHUNK_RATE_LIMIT' },
  keyGenerator: studioKeyGenerator,
});

// Teure KI-/Cloud-/Upload-Routen: enges Limit je Nutzer-/Session-Identitaet
// (Kostenbremse). Legacy-Env API_EXPENSIVE_RATE_LIMIT_MAX bleibt respektiert
// (Server-Tests/Lasttests).
const legacyExpensiveMax = Number(process.env.API_EXPENSIVE_RATE_LIMIT_MAX || 0);
const expensiveLimiter = rateLimit({
  windowMs: AI_RATE.expensiveWindowMs,
  max: legacyExpensiveMax > 0 ? legacyExpensiveMax : AI_RATE.expensiveMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many expensive requests, please try again later.' },
  keyGenerator: studioKeyGenerator,
  // Statusabfragen eines Laufs kosten nichts (nur das Starten/Fortsetzen).
  skip: isAgentReadRequest,
});

app.use('/api/health', healthLimiter);
app.use(CSP_REPORT_PATH, cspReportLimiter);
app.use('/api', apiLimiter);
// `/api/upload/sample` (Scan + Ablage) bleibt unter der Kostenbremse; die
// Chunk-Routen nicht - sie laufen dafuer unter `uploadChunkLimiter`.
app.use(['/api/ai', '/api/voice', '/api/sound', '/api/song', '/api/separate-stems', '/api/cloud/upload', '/api/cloud/sync', '/api/upload/sample'], expensiveLimiter);
app.use('/api/upload/chunk', uploadChunkLimiter);
app.use('/api/ai/agent/runs', agentLimiter);

// F7-Fix: Meldeweg der CSP (tokenfrei, rate-limitiert, 204 ohne Inhalt).
registerSecurityRoutes(app);

// ARCH-P2-002: Die Betriebs-/Telemetrie-Routen liegen in server/routes/opsRoutes.ts (Factory). Registrierung an der
// Originalposition, damit die Reihenfolge relativ zu den Middleware-Ketten
// unveraendert bleibt.
registerOpsRoutes(app, {
  STEM_MAX_JOBS,
  getActiveSocketConnections: () => realtimeHub?.getActiveSocketConnections() ?? 0,
  getStemActiveJobs,
  metrics,
  serverAuditLog,
});

// ARCH-P2-002: Die Media-/Info-Routen liegen in server/routes/mediaRoutes.ts
// (Factory). Registrierung an der Originalposition, damit die Reihenfolge relativ
// zu den Middleware-Ketten unveraendert bleibt.
registerMediaRoutes(app);

// VISUAL-P1-001: MJPEG-Fallback fuer den Beamer (Ghostuser 6) - der Spec-Punkt
// "Fallback ohne SFU" war nie gebaut. Der Hub ist EINE Instanz pro Prozess; bei
// mehreren App-Knoten liefert der Knoten, der die Frames bekommt (Beamer-URL
// also auf denselben Knoten zeigen lassen wie die Studio-Session).
const visualFrameHub = new VisualFrameHub();
registerVisualRoutes(app, {
  hub: visualFrameHub,
  tokenFromRequest: studioTokenFromRequest,
  safeTokenEqual,
  studioAccessToken: STUDIO_ACCESS_TOKEN,
  studioAuthOpen,
});

// ===========================================================================
// Externe Cloud-Anbindung (Supabase + Cloudflare R2)
// ===========================================================================
// Ergänzende Endpunkte für die externe Sample-/Musik-Datenbank:
//   GET  /api/cloud/health   → Konfiguration/Aufrufstatus (Supabase, R2)
//   POST /api/cloud/sync     → Seeds die eingebauten Presets in Supabase
// Betrieb nur, wenn die Keys in `.env` gesetzt sind (andernfalls melden die
// Endpunkte 'not-configured' – die App bleibt weiterhin voll offline-fähig).

// ARCH-P2-002: Die Handler liegen in server/routes/cloudRoutes.ts (Factory).
// Die Registrierung bleibt an dieser Stelle, damit die Reihenfolge relativ zu
// den oben gesetzten Middleware-/Rate-Limit-Ketten unveraendert ist.
registerCloudRoutes(app);
// ===========================================================================
// Lokale, cloud-freie Endpunkte
// Diese Endpunkte halten die Frontend-Funktionen (KI-Komposition, Stems,
// Voice) am Laufen, ohne externe Cloud-Anbieter zu nutzen.
//
// Hinweis: Falls spaeter ein echter Backend-Service (z.B. services/backend-core
// mit eigenem Host) betrieben wird, kann hier ein Proxy eingebaut werden.
// ===========================================================================

// ARCH-P2-002: Die /api/ai-Routen liegen in server/routes/aiRoutes.ts (Factory).
// Die Registrierung bleibt an dieser Stelle, damit die Reihenfolge relativ zu den
// Middleware-/Rate-Limit-Ketten unveraendert ist.
registerAiRoutes(app, { metrics, fleetTargets });

// AI-P1-006: aiMONK-Agent-Loop (planen -> ausfuehren -> pruefen) mit Abbruch,
// Wiederaufnahme und Kostenausweis. Der Loop selbst ist `MoaAgent.run` (seit
// AI-P1-003 P5 im Einsatz, siehe VoiceControlService) - hier kommt der
// persistente Lauf darum herum: `ResumableAgentRunner` schreibt jeden Lauf auf
// Platte, bricht kooperativ ab und setzt beim Originalplan fort.
// Serverseitige Laeufe planen gegen die MCP-WERKZEUGE und fuehren sie auch aus
// (AI-P1-006): der Server hat keine Plugin-Registry (die lebt im Browser), dafuer
// aber echte Werkzeuge - session.getState, runtime.status, fleet.status,
// models.list, sample.search. Der Katalog wird aus der Werkzeugliste abgeleitet,
// deshalb kann der Planer nichts planen, was nicht ausfuehrbar ist.
const agentAllowExecutionTools = process.env.AI_AGENT_ALLOW_EXECUTION_TOOLS === '1';
const agentPlanCatalog = catalogFromMcpTools(aiOrchestrator.mcp.listTools(), {
  allowExecution: agentAllowExecutionTools,
});
const serverAgent = new MoaAgent(
  undefined, // Standard-LLM-Pfad (clientLlm -> llmRouter)
  createMcpAgentExecutor({ mcp: aiOrchestrator.mcp, allowExecution: agentAllowExecutionTools }),
  undefined, // Kostenschaetzung (Default)
  undefined, // Zeitlimit (Default/Env)
  agentPlanCatalog,
);
console.log(`[agent] serverseitige Werkzeuge: ${agentPlanCatalog || '(keine)'}`);
registerAgentRoutes(app, { runner: new ResumableAgentRunner({ agent: serverAgent }) });

// ARCH-P2-002: Die Stem-Separation liegen in server/routes/stemRoutes.ts (Factory). Registrierung an der
// Originalposition, damit die Reihenfolge relativ zu den Middleware-Ketten
// unveraendert bleibt.
registerStemRoutes(app, {
  STEM_MAX_JOBS,
  fleetTargets,
  metrics,
  parseMultipartStream,
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

// ARCH-P2-002: Die Admin-/Debug-Route liegt in server/routes/adminRoutes.ts
// (Factory). Registrierung an der Originalposition, damit die Reihenfolge relativ
// zu den Middleware-Ketten unveraendert bleibt.
registerAdminRoutes(app, {
  getStemActiveJobs,
  metrics,
  safeTokenEqual,
});

// ARCH-P2-002: Die Handler liegen in server/routes/sessionRoutes.ts (Factory).
// Die Dependencies greifen live auf den Module-Scope zu - insbesondere
// serverIo, das erst beim Socket-Aufbau gesetzt wird (weiter unten) und
// deshalb als Getter uebergeben wird, nicht als Wertkopie.
registerSessionRoutes(app, {
  isProductionEnv,
  studioAccessToken: STUDIO_ACCESS_TOKEN,
  tokenFromRequest: studioTokenFromRequest,
  safeTokenEqual,
  newSession: () => new AuthoritativeSession({ lockTtlMs: PLUGIN_LOCK_TTL_MS }),
  replaceSession: (session) => {
    sessionRuntime.setSession(session);
  },
  // Der Save-Timer liegt in der Laufzeit; `stop()` bricht ihn ab. Frueher stand
  // hier eine eigene Kopie der Timer-Verwaltung - die zweite Stelle war genau
  // die Art von Zustand, die diese Zerlegung aufloest.
  clearSaveTimer: () => {
    sessionRuntime.stopSaveTimer();
  },
  get serverIo() {
    return serverIo;
  },
  uploadToR2: uploadSampleToR2,
});

// ARCH-P2-002: Die /api/master-Routen liegen in server/routes/masterRoutes.ts
// (Factory). Registrierung an der Originalposition, damit die Reihenfolge relativ
// zu den Middleware-Ketten unveraendert bleibt.
registerMasterRoutes(app, { getMasterPlayerUrl });

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

// ARCH-P2-002: Die Upload-Route liegen in server/routes/uploadRoutes.ts (Factory). Registrierung an der
// Originalposition, damit die Reihenfolge relativ zu den Middleware-Ketten
// unveraendert bleibt.
registerUploadRoutes(app, {
  getMasterPlayerUrl,
  parseMultipartStream,
});

// ARCH-P2-002: Die Voice-Familie (/api/voice, /api/sound, /api/song) liegt in
// server/routes/voiceRoutes.ts (Factory). Registrierung an der Originalposition,
// damit die Reihenfolge relativ zu den Middleware-Ketten unveraendert bleibt.
registerVoiceRoutes(app);

// ===========================================================================
// Static Asset delivery (Vite dev / production dist)
// ===========================================================================
async function startServer(port: number = PORT): Promise<{ httpServer: http.Server; io: unknown } | null> {
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

  // ARCH-P2-002: Socket.io-Signalisierung, Session-Raum, Locks, Plugin-State,
  // Main-Out-Ownership, Telemetrie und der optionale SFU liegen in
  // server/realtime.ts. Hier wird die Schicht nur noch verdrahtet.
  const hub = await createRealtimeHub(server, {
    sessionRuntime,
    addServerAudit,
    resolveSessionMainOutUserId,
    pluginLockTtlMs: PLUGIN_LOCK_TTL_MS,
    studioTokenMissing,
    studioAuthOpen,
    studioAccessToken: STUDIO_ACCESS_TOKEN,
    studioSessionSecret: STUDIO_SESSION_SECRET,
    safeTokenEqual,
    looksLikeStudioSession,
    verifyStudioSession,
  });
  serverIo = hub.io;
  realtimeHub = hub;

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`audioMONASTRY running on http://0.0.0.0:${port}`);
      resolve();
    });
  });

  // AI-P1-007: MOS-Hörerwertungen aus der Persistenz zurückholen, damit ein
  // Neustart sie nicht mehr verliert (live belegt 2026-09-17: sechs Wertungen
  // waren nach dem Neustart weg). Bewusst awaited – der Zustand ist ab dem
  // ersten Request korrekt; Fehler sind nicht fatal (loadEvaluations fängt).
  try {
    const restored = await mosHarness.loadPersisted();
    if (restored.loaded > 0) {
      console.log(`[mos] ${restored.loaded} Hörerwertungen aus der Persistenz geladen (${restored.total} gesamt)`);
    }
  } catch (e) {
    console.warn('[mos] Laden der Hörerwertungen fehlgeschlagen:', (e as Error).message);
  }

  // INFRA-AI-003: Prompt-Versionen aus der Persistenz in den Store holen. Vorher
  // las kein Produktionspfad den Store – eine „optimierte" Version (iterate:prompts)
  // blieb ein DB-Eintrag und erreichte nie einen echten Plan-Aufruf. Bewusst
  // awaited wie oben; ohne Supabase bleibt der Store leer und es gilt die Konstante.
  try {
    const promptRows = await aiPersistence.loadSystemPrompts();
    const loaded = promptStore.hydrate(promptRows);
    if (loaded > 0) {
      console.log(`[ai] ${loaded} Prompt-Version(en) aus der Persistenz in den Store geladen`);
    }
  } catch (e) {
    console.warn('[ai] Laden der Prompt-Versionen fehlgeschlagen:', (e as Error).message);
  }
  return { httpServer: server, io: hub.io };
}

export { app, startServer };

if (
  process.env.VITEST !== 'true' &&
  process.env.NODE_ENV !== 'test' &&
  process.env.AUDIOMONASTRY_NO_AUTOSTART !== '1'
) {
  startServer();
}
