import express from 'express';
import * as BusboyModule from 'busboy';
import { random } from './src/utils/random';
import http from 'http';
import path from 'path';
import {
  createHash,
} from 'crypto';
import compression from 'compression';
import dotenv from 'dotenv';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { pushSampleToCloud, uploadSampleToR2 } from './server/cloud.ts';
import { llmRouter } from './src/core/ai/LlmRouter';
import { resolveAiRateLimits } from './src/config/aiRateLimits';
import { isListenerMode, normalizeSessionMode } from './src/core/session/listenerMode';
// ARCH-P2-002: server.ts wird schrittweise zerlegt. Route-Gruppen liegen als
// Factories unter server/routes/ und werden an ihrer Originalposition
// registriert (Reihenfolge = Middleware-Reihenfolge, siehe app.use oben).
import { registerCloudRoutes } from './server/routes/cloudRoutes.ts';
import { registerSessionRoutes } from './server/routes/sessionRoutes.ts';
import { registerAiRoutes } from './server/routes/aiRoutes.ts';
import { registerMasterRoutes } from './server/routes/masterRoutes.ts';
import { registerVoiceRoutes } from './server/routes/voiceRoutes.ts';
import { registerOpsRoutes } from './server/routes/opsRoutes.ts';
import { registerMediaRoutes } from './server/routes/mediaRoutes.ts';
import { buildPluginStateRelayPayload } from './src/core/session/pluginStateRelay';
import {
  AuthoritativeSession,
  MemorySessionPersistence,
  type AuthoritativeSessionPersistence,
  type SerializedAuthoritativeSession,
} from './src/core/session/authoritativeSession';
import { looksLikeStudioSession, verifyStudioSession } from './src/core/session/studioSession';
import {
  canControlMainOut,
  isMainOutPlugin,
  parseMainOutUpdate,
  resolveMainOutUserId,
} from './src/core/session/mainOutGuard';
import { SnapshotStore, createMemoryKeyValueStore } from './src/core/persistence/snapshotStore';
import type { AudioSample } from './src/data/samples';
import {
  PluginLockSocketSchema,
  PluginStateSocketSchema,
} from './src/types/zod/schemas';

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
// S-9: Fleet-Map-URL validieren (https-only, sonst Default).
const FLEET_MAP_URL_RAW = (process.env.FLEET_MAP_URL || '').trim();
let FLEET_MAP_URL = 'https://anunnakitools.de/api/fleet-map';
try {
  const u = new URL(FLEET_MAP_URL_RAW || FLEET_MAP_URL);
  if (u.protocol === 'https:') FLEET_MAP_URL = u.toString();
} catch { /* Default behalten */ }
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

// ROLLENSYSTEM ENTFERNT (2026-09-14): Kein admin/producer/engineer/guest mehr.
// Es gibt nur noch: Session-Mitglieder (equal) + der mixerMONK-Lock-Owner (DJ).
const MAIN_OUT_USER_ID = (process.env.MAIN_OUT_USER_ID || '').trim();
function resolveSessionMainOutUserId(): string {
  const lockOwner = authoritativeSession.lockOwner('mixer');
  if (lockOwner) return lockOwner;
  return resolveMainOutUserId(MAIN_OUT_USER_ID, []);
}
// COLLAB-P0-001: Serverautoritativer Session-State (Revision/Sequenz/Snapshot +
// atomare Locks) ersetzt die frühere rohe `pluginLocks`-Map. Der Client bleibt
// optimistisch; der Server verwirft verspätete/doppelte Events deterministisch.
const PLUGIN_LOCK_TTL_MS = 60_000; // 60 s + Heartbeat-Verlängerung (Fallback)
const PLUGIN_LOCK_SWEEP_MS = 15_000;
const SESSION_STATE_REDIS_KEY = 'audiomonastry:session-state';
let authoritativeSession = new AuthoritativeSession({ lockTtlMs: PLUGIN_LOCK_TTL_MS });
let sessionPersistence: AuthoritativeSessionPersistence = new MemorySessionPersistence();
let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
/** Socket.io-Referenz für Modul-Scope-Routen (E2E-Reset); null vor Start. */
let serverIo: any = null;

// P1-2: Automatische Snapshots des autoritativen Session-States mit
// Checksumme, Retention und trockenem Cleanup (dokumentiert in
// docs/ENV_MATRIX.md bzw. docs/PERSISTENZ). SnapshotStore ist rein; hier wird
// SHA-256 als Prüfsumme injiziert (node:crypto ist in server.ts erlaubt).
const sessionSnapshotStore = new SnapshotStore<SerializedAuthoritativeSession>(
  createMemoryKeyValueStore(),
  {
    maxSnapshots: Math.max(1, Number(process.env.SNAPSHOT_MAX_SNAPSHOTS ?? 20)),
    maxAgeMs: Math.max(0, Number(process.env.SNAPSHOT_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000)),
    checksum: (input: string) => createHash('sha256').update(input).digest('hex'),
  },
);
const SNAPSHOT_INTERVAL_MS = Math.max(1_000, Number(process.env.SNAPSHOT_INTERVAL_MS ?? 60_000));
/** Ein Snapshot + Retention-Lauf (best effort, wirft nie). */
const persistSnapshotNow = (): void => {
  const serialized = authoritativeSession.serialize();
  void sessionSnapshotStore.write(serialized, serialized.revision)
    .then(() => sessionSnapshotStore.prune())
    .catch((err) => console.warn('[snapshot] persistieren fehlgeschlagen:', (err as Error).message));
};
setInterval(persistSnapshotNow, SNAPSHOT_INTERVAL_MS).unref?.();

/** Debounced Persistenz (Redis im Multi-Instanz-Betrieb, sonst In-Memory). */
const persistSessionState = (): void => {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    void sessionPersistence.save(authoritativeSession.serialize()).catch(() => { /* best effort */ });
    // P1-2: auch Snapshot-Store aktualisieren (debounced, kein Extra-Timer nötig).
    persistSnapshotNow();
  }, 250);
  sessionSaveTimer.unref?.();
};
/** Legacy-Sicht der Locks für `plugin-locks-sync` (Client-Format, unverändert). */
const legacyLockMap = (): Record<string, { lockedBy: string; timestamp: number; ttl: number }> => {
  const now = Date.now();
  return Object.fromEntries(authoritativeSession.snapshot(now).locks.map((l) => [
    l.objectId,
    { lockedBy: l.ownerId, timestamp: now, ttl: Math.max(0, l.leaseUntil - now) },
  ]));
};
// ARCH-#2: Ablauf broadcasten – Callback wird im Socket.io-Setup gesetzt
// (io + SESSION_ROOM_ID leben dort im Scope). Null = noch nicht initialisiert.
let broadcastLockExpiry: ((pluginId: string) => void) | null = null;
const sweepPluginLocks = (): void => {
  for (const pluginId of authoritativeSession.sweepExpiredLocks()) {
    // ARCH-#2: Ablauf aktiv an ALLE Session-Teilnehmer broadcasten (statt
    // stillschweigend zu löschen) – sonst bleibt der Lock clientseitig
    // hängen und das Plugin erscheint für andere weiter als gesperrt.
    broadcastLockExpiry?.(pluginId);
  }
};
setInterval(sweepPluginLocks, PLUGIN_LOCK_SWEEP_MS).unref?.();

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
// besondere Regeln brauchen). S-7: Report-Only-CSP zum Sammeln von Verstößen.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader(
    'Content-Security-Policy-Report-Only',
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob: data:",
      "connect-src 'self' https://api.deepseek.com https://router.huggingface.co https://api-inference.huggingface.co https://*.endpoints.huggingface.cloud https://api.openai.com wss: https:",
      "frame-ancestors 'none'",
    ].join('; '),
  );
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

// ARCH-P2-002: Die Betriebs-/Telemetrie-Routen liegen in server/routes/opsRoutes.ts (Factory). Registrierung an der
// Originalposition, damit die Reihenfolge relativ zu den Middleware-Ketten
// unveraendert bleibt.
registerOpsRoutes(app, {
  STEM_MAX_JOBS,
  getActiveSocketConnections: () => activeSocketConnections,
  getStemActiveJobs: () => stemActiveJobs,
  metrics,
  serverAuditLog,
});

// ARCH-P2-002: Die Media-/Info-Routen liegen in server/routes/mediaRoutes.ts
// (Factory). Registrierung an der Originalposition, damit die Reihenfolge relativ
// zu den Middleware-Ketten unveraendert bleibt.
registerMediaRoutes(app);

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


// --- Admin/Root-Debug (nur mit ADMIN_TOKEN, z. B. fuer Root-Debugging) -------
app.get('/api/admin/debug', (req, res) => {
  const adminToken = (process.env.ADMIN_TOKEN || '').trim();
  const supplied = String(req.headers['x-admin-token'] ?? '');
  if (!adminToken || !safeTokenEqual(supplied, adminToken)) {
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
    authoritativeSession = session;
  },
  clearSaveTimer: () => {
    if (sessionSaveTimer) {
      clearTimeout(sessionSaveTimer);
      sessionSaveTimer = null;
    }
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

  let io: any = null;

  try {
    const { Server } = (await import('socket.io')) as any;
    io = new Server(server, {
      cors: {
        origin: CORS_ORIGIN,
        methods: ['GET', 'POST'],
      },
      path: '/webrtc-signaling',
    });
    serverIo = io;

    // P-11: Handshake-Auth + Origin-Prüfung. Mit STUDIO_ACCESS_TOKEN müssen
    // Clients das `studio`-Cookie (vom Portal gesetzt) mitschicken.
    io.use(async (socket: any, next: (err?: Error) => void) => {
      const origin = String(socket.handshake?.headers?.origin ?? '');
      if (
        ALLOWED_ORIGINS.length > 0 &&
        !ALLOWED_ORIGINS.includes('*') &&
        origin &&
        !ALLOWED_ORIGINS.includes(origin)
      ) {
        return next(new Error('origin-not-allowed'));
      }
      // P0-Security: fail-closed – ohne Studio-Token und ohne expliziten
      // Dev-/Test-Modus keine Signalisierung/WebRTC.
      if (studioTokenMissing) {
        return next(new Error('server-not-configured'));
      }
      if (!studioAuthOpen) {
        const cookie = String(socket.handshake?.headers?.cookie ?? '');
        const m = cookie.match(/(?:^|;\s*)studio=([^;]+)/);
        const token = String(socket.handshake?.auth?.token ?? '') ||
          String(socket.handshake?.headers?.['x-studio-token'] ?? '') ||
          (m ? decodeURIComponent(m[1]) : '');
        const masterOk = Boolean(token) && safeTokenEqual(token, STUDIO_ACCESS_TOKEN);
        // SEC-P2-002: zusätzlich das kurzlebige Portal-Session-Token akzeptieren.
        const sessionOk = !masterOk && Boolean(token) && looksLikeStudioSession(token)
          && (await verifyStudioSession(token, STUDIO_SESSION_SECRET));
        if (!masterOk && !sessionOk) {
          return next(new Error('unauthorized'));
        }
      }
      next();
    });

    // Multi-Instanz-Modus: Mit REDIS_URL teilen sich alle App-Knoten die
    // Socket.io-Räume (Session-/Plugin-State über Prozessgrenzen hinweg).
    // S-9: REDIS_URL nur mit redis/rediss-Schema akzeptieren.
    let redisUrl = (process.env.REDIS_URL || '').trim();
    if (redisUrl && !/^rediss?:\/\//i.test(redisUrl)) {
      console.warn('[signaling] REDIS_URL ungültig (Schema) – In-Memory-Adapter aktiv.');
      redisUrl = '';
    }
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
        // COLLAB-P0-001: Session-State + Locks über Redis sichern, damit ein
        // Server-Neustart / eine zweite Instanz keinen State verliert. Best-effort:
        // Fehler dürfen den Audio-/Signaling-Betrieb nicht beeinträchtigen.
        const redisPersistence: AuthoritativeSessionPersistence = {
          async load(): Promise<SerializedAuthoritativeSession | null> {
            try {
              const raw = await pubClient.get(SESSION_STATE_REDIS_KEY);
              if (typeof raw !== 'string' || raw.length === 0) return null;
              return JSON.parse(raw) as SerializedAuthoritativeSession;
            } catch {
              return null;
            }
          },
          async save(state: SerializedAuthoritativeSession): Promise<void> {
            try {
              await pubClient.set(SESSION_STATE_REDIS_KEY, JSON.stringify(state));
            } catch {
              /* best effort */
            }
          },
        };
        const restored = await redisPersistence.load();
        if (restored) authoritativeSession = AuthoritativeSession.restore(restored, { lockTtlMs: PLUGIN_LOCK_TTL_MS });
        sessionPersistence = redisPersistence;
        console.log(`Redis-Adapter aktiv (Socket.io Multi-Instanz). Session-State ${restored ? `wiederhergestellt (rev=${authoritativeSession.revision})` : 'neu'}.`);
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

      // S-2: Signaling-Relay mit Ziel-Validierung – es darf nur an Sockets
      // derselben Session geroutet werden (nie an fremde/ungültige Socket-IDs).
      const relayToSessionPeer = (event: string, data: any, payload: Record<string, unknown>): void => {
        const targetId = String(data?.target ?? '').trim();
        if (!targetId) return;
        const target = io.sockets.sockets.get(targetId);
        if (!target) return;
        const sameRoom = !!socket.data?.sessionRoom
          && target.data?.sessionRoom === socket.data.sessionRoom;
        if (!sameRoom) return;
        target.emit(event, payload);
      };

      socket.on('offer', (data: any) => {
        refreshIdleTimer();
        if (!data.offer) return;
        relayToSessionPeer('offer', data, { offer: data.offer, sender: socket.id, senderMode: socket.data?.sessionMode ?? 'member' });
      });
      socket.on('answer', (data: any) => {
        refreshIdleTimer();
        if (!data.answer) return;
        relayToSessionPeer('answer', data, { answer: data.answer, sender: socket.id });
      });
      socket.on('ice-candidate', (data: any) => {
        refreshIdleTimer();
        if (!data.candidate) return;
        relayToSessionPeer('ice-candidate', data, { candidate: data.candidate, sender: socket.id });
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

      const sessionMembers = (room: string, excludeSocketId: string) => {
        const members: { socketId: string; userId: string; role: string }[] = [];
        const sockets = io.sockets.adapter.rooms.get(room);
        if (sockets) {
          for (const sid of sockets) {
            if (sid === excludeSocketId) continue;
            const s = io.sockets.sockets.get(sid);
            // Listener (Ghostuser 5/6) zählen NICHT als Session-Mitglieder.
            if (s?.data?.sessionUserId && !isListenerMode(normalizeSessionMode(s?.data?.sessionMode))) {
              members.push({ socketId: sid, userId: s.data.sessionUserId, role: s.data.sessionRole ?? 'guest' });
            }
          }
        }
        return members;
      };

      /**
       * COLLAB-P0-002: Mitgliederliste serverautoritativ an ALLE Session-Sockets
       * verteilen (jeder bekommt die Liste OHNE sich selbst). Vorher bekam nur der
       * Beitretende eine `session-members`-Nachricht; die anderen erfuhren eine
       * Änderung nur über `peer-joined` — ein Client, der beim Join noch nicht
       * zuhörte (Modul-Init vor React-Mount), blieb dauerhaft auf einem alten
       * Zähler stehen (live nachgestellt 2026-09-13).
       */
      const broadcastSessionMembers = (room: string): void => {
        const sockets = io.sockets.adapter.rooms.get(room);
        if (!sockets) return;
        for (const sid of sockets) {
          const s = io.sockets.sockets.get(sid);
          if (!s?.data?.sessionUserId) continue;
          const selfMode = normalizeSessionMode(s.data.sessionMode);
          s.emit('session-members', {
            roomId: SESSION_ROOM_ID,
            members: sessionMembers(room, sid),
            selfMode,
            mainOutUserId: resolveSessionMainOutUserId(),
          });
        }
      };

      socket.on('join-session', (data: any) => {
        refreshIdleTimer();
        const userId = String(data?.userId ?? socket.id).trim();
        // MASTEROUTMAINSTREAM/VISUALOUTMAINSTREAM: eigener Listen-Modus – zählt
        // nicht zu den 4 Usern, sendet selbst nichts und bekommt die
        // Mitgliederliste, um den Host zu finden (Szenario: 4 iPads + Laptop an
        // der PA (/master-out) + Beamer (/visual-out)).
        const mode = normalizeSessionMode(data?.mode);
        const room = `session:${SESSION_ROOM_ID}`;
        socket.data.sessionUserId = userId;
        socket.data.sessionRoom = SESSION_ROOM_ID;
        socket.data.sessionMode = mode;
        // ROLLENSYSTEM ENTFERNT: alle Session-User sind gleich; nur der
        // mixerMONK-Lock-Owner ist besonders (Main-Out).
        socket.data.sessionRole = 'member';
        addServerAudit(userId, 'member', mode === 'master-out' ? 'JOIN_MASTER_OUT' : mode === 'visual-out' ? 'JOIN_VISUAL_OUT' : 'JOIN_SESSION', true, SESSION_ROOM_ID);
        socket.join(room);
        // K-2: Aktive Locks an den neuen Teilnehmer synchronisieren (Legacy-Format).
        socket.emit('plugin-locks-sync', {
          roomId: SESSION_ROOM_ID,
          locks: legacyLockMap(),
        });
        // COLLAB-P0-001: vollständiger, serverautoritativer Snapshot für
        // Join/Reconnect – Revision + Modul-States + Locks + Sequenzen.
        {
          const snapshot = authoritativeSession.snapshot();
          socket.emit('session-state', {
            roomId: SESSION_ROOM_ID,
            revision: snapshot.revision,
            modules: snapshot.modules,
            locks: snapshot.locks,
            sequences: snapshot.sequences,
            serverTime: snapshot.serverTime,
          });
        }

        const members = sessionMembers(room, socket.id);
        if (isListenerMode(mode)) {
          // Nicht an die Session-Mitglieder ankündigen (kein peer-joined), damit
          // niemand Mikrofon-Tracks an den Listener schickt. Der Listener
          // initiiert seine Verbindung selbst zum Host.
          socket.emit('session-members', {
            roomId: SESSION_ROOM_ID,
            members,
            selfMode: mode,
            mainOutUserId: resolveSessionMainOutUserId(),
          });
          return;
        }

        if (members.length >= MAX_SESSION_USERS) {
          socket.emit('session-full', { roomId: SESSION_ROOM_ID, max: MAX_SESSION_USERS });
          socket.leave(room);
          return;
        }

        // COLLAB-P0-002: Erst dem Raum den neuen Peer ankündigen, dann allen
        // (inklusive dem Neuen) die autoritative Mitgliederliste schicken.
        socket.to(room).emit('peer-joined', { roomId: SESSION_ROOM_ID, socketId: socket.id, userId });
        broadcastSessionMembers(room);
      });

      // K-2/K-5: Server-autoritative Plugin-Locks (Client bleibt optimistisch).
      socket.on('plugin-lock', (data: any) => {
        refreshIdleTimer();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const parsed = PluginLockSocketSchema.safeParse(data ?? {});
        if (!parsed.success) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const pluginId = parsed.data.pluginId;
        const acquired = authoritativeSession.acquireLock(pluginId, senderUserId);
        if (!acquired.ok) {
          socket.emit('plugin-lock-denied', { pluginId, lockedBy: acquired.lockedBy ?? null });
          return;
        }
        persistSessionState();
        const lock = { lockedBy: senderUserId, timestamp: Date.now(), ttl: PLUGIN_LOCK_TTL_MS };
        const revision = authoritativeSession.revision;
        socket.to(`session:${roomId}`).emit('plugin-lock', { pluginId, ...lock, revision });
        socket.emit('plugin-lock', { pluginId, ...lock, revision });
        if (pluginId === 'mixer') broadcastMainOutOwner(`session:${roomId}`);
        addServerAudit(senderUserId, String(socket.data?.sessionRole ?? 'guest'), 'PLUGIN_LOCK', true, pluginId);
      });
      // ARCH-#2: Broadcast-Callback für Lock-Ablauf (Sweep im Modul-Scope).
      broadcastLockExpiry = (pluginId: string) => {
        io.to(`session:${SESSION_ROOM_ID}`).emit('plugin-unlock', {
          pluginId,
          lockedBy: null,
          reason: 'expired',
        });
        broadcastMainOutOwner(`session:${SESSION_ROOM_ID}`);
      };
      // P0-1 (revidiert): Main-Out-Owner bei jedem Lock-Wechsel an den Raum
      // broadcasten – die Clients spiegeln sonst einen veralteten Owner.
      const broadcastMainOutOwner = (roomId: string): void => {
        io.to(roomId).emit('main-out-owner', { userId: resolveSessionMainOutUserId(), ts: Date.now() });
      };
      socket.on('plugin-unlock', (data: any) => {
        refreshIdleTimer();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const parsed = PluginLockSocketSchema.safeParse(data ?? {});
        if (!parsed.success) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const pluginId = parsed.data.pluginId;
        if (!authoritativeSession.releaseLock(pluginId, senderUserId)) return;
        persistSessionState();
        socket.to(`session:${roomId}`).emit('plugin-unlock', { pluginId, userId: senderUserId, revision: authoritativeSession.revision });
        if (pluginId === 'mixer') broadcastMainOutOwner(`session:${roomId}`);
        addServerAudit(senderUserId, String(socket.data?.sessionRole ?? 'guest'), 'PLUGIN_UNLOCK', true, pluginId);
      });

      // COLLAB-P0-001: Reconnect-Resync – der Client fordert den vollständigen
      // autoritativen Zustand an, ohne die Session neu zu betreten (kein Pumping).
      socket.on('resync-session', () => {
        refreshIdleTimer();
        if (!socket.data?.sessionRoom) return;
        const snapshot = authoritativeSession.snapshot();
        socket.emit('plugin-locks-sync', { roomId: SESSION_ROOM_ID, locks: legacyLockMap() });
        socket.emit('session-state', {
          roomId: SESSION_ROOM_ID,
          revision: snapshot.revision,
          modules: snapshot.modules,
          locks: snapshot.locks,
          sequences: snapshot.sequences,
          serverTime: snapshot.serverTime,
        });
      });

      // DCT-102: Socket.io-Relay für Modul-/AUTO_AI-State, wenn WebRTC-DataChannels
      // (noch) nicht offen sind – deterministischer Fallback über den Signaling-Pfad.
      socket.on('plugin-state', (data: any) => {
        refreshIdleTimer();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const parsed = PluginStateSocketSchema.safeParse(data ?? {});
        if (!parsed.success) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const senderRole = String(socket.data?.sessionRole ?? 'guest');
        const { pluginId, state } = parsed.data;
        // K-2: Lock serverseitig durchsetzen – nur der Halter darf den State ändern.
        const lockOwner = authoritativeSession.lockOwner(pluginId);
        if (lockOwner && lockOwner !== senderUserId) {
          addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', false, pluginId);
          socket.emit('rbac-denied', { action: 'plugin-state', pluginId, state, role: senderRole, reason: 'locked by other' });
          return;
        }
        // ROLLENSYSTEM ENTFERNT: keine Rollen-Prüfung für PRO/OFF/AUTO_AI mehr.
        // Jeder Session-User darf Plugins schalten; Locks + Main-Out-Schutz
        // (unten) regeln die Exklusivität.
        // P0-1: Main-Out-Schutz – mixer/master-Zustand ändert nur der MixerMONK
        // (Main-Out-Owner). Andere User dürfen den Main-Out nicht schalten,
        // auch nicht auf OFF (OFF würde das Main-Signal abwürgen).
        if (isMainOutPlugin(pluginId) && !canControlMainOut(senderUserId, resolveSessionMainOutUserId())) {
          addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', false, `${pluginId}:main-out protected`);
          socket.emit('rbac-denied', {
            action: 'plugin-state',
            pluginId,
            state,
            reason: 'main-out protected (mixerMONK only)',
            mainOutUserId: resolveSessionMainOutUserId(),
          });
          return;
        }
        // COLLAB-P0-001: doppelte/verspätete Events deterministisch verwerfen.
        const eventId = parsed.data.eventId
          ?? `${senderUserId}:${pluginId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        const applied = authoritativeSession.applyEvent({
          id: eventId,
          type: 'plugin-state',
          senderUserId,
          pluginId,
          state,
          sequence: parsed.data.sequence,
        });
        if (!applied.accepted) {
          addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', false, `${pluginId}:${applied.reason}`);
          socket.emit('plugin-state-rejected', {
            pluginId,
            eventId,
            reason: applied.reason ?? 'invalid',
            revision: applied.revision,
          });
          return;
        }
        persistSessionState();
        addServerAudit(senderUserId, senderRole, 'PLUGIN_STATE', true, pluginId);
        // Session-Identität + Revision/Event-ID: Empfänger können ordnen/deduplizieren.
        // COLLAB-P0-002: Payload über den getesteten Vertrags-Builder bauen. Der
        // frühere Spread `{ ...parsed.data }` enthielt KEIN type, senderId und
        // timestamp (Zod strippt unbekannte Keys) - die Clients haben das Relay
        // deshalb in dispatchDataMessage verworfen, und die State-Spiegelung hing
        // allein an offenen DataChannels.
        const payload = buildPluginStateRelayPayload({
          pluginId,
          state,
          senderUserId,
          senderRole,
          revision: applied.revision,
          eventId,
          sequence: parsed.data.sequence,
          timestamp: parsed.data.timestamp,
        });
        socket.to(`session:${roomId}`).emit('plugin-state', payload);
        socket.emit('plugin-state-ack', { pluginId, eventId, revision: applied.revision });
      });

      // COLLAB-P1-004: Aktives Plugin/Nav an die Session spiegeln. Reiner
      // UI-Hinweis (kein Audio-State, keine Lock-Wirkung) – egal welcher User
      // gerade welches Modul bedient, die anderen sehen es im Header.
      socket.on('session-nav', (data: any) => {
        refreshIdleTimer();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const senderRole = String(socket.data?.sessionRole ?? 'guest');
        const pluginId = String(data?.pluginId ?? '').trim().slice(0, 64);
        if (!pluginId) return;
        const payload = { pluginId, senderUserId, senderRole, ts: Date.now() };
        socket.to(`session:${roomId}`).emit('session-nav', payload);
      });

      // P0-1: Server-validierter Main-Out-Parameterkanal (MixerMONK exklusiv).
      // Clients, die Main-Out-Parameter (masterVolume, Fades, …) ändern wollen,
      // senden hierhin statt über den unkontrollierten Peer-Pfad. Der Server
      // validiert Berechtigung + Payload und broadcastet an den Session-Raum.
      socket.on('main-out-update', (data: unknown) => {
        refreshIdleTimer();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const senderUserId = String(socket.data?.sessionUserId ?? socket.id);
        const senderRole = String(socket.data?.sessionRole ?? 'guest');
        const mainOutUserId = resolveSessionMainOutUserId();
        if (!canControlMainOut(senderUserId, mainOutUserId)) {
          addServerAudit(senderUserId, senderRole, 'MAIN_OUT_UPDATE', false);
          socket.emit('rbac-denied', {
            action: 'main-out-update',
            role: senderRole,
            reason: 'main-out protected (MixerMONK only)',
            mainOutUserId,
          });
          return;
        }
        const parsed = parseMainOutUpdate(data);
        if (!parsed) {
          socket.emit('main-out-update-rejected', { reason: 'invalid payload' });
          return;
        }
        addServerAudit(senderUserId, senderRole, 'MAIN_OUT_UPDATE', true, parsed.param);
        const payload = {
          param: parsed.param,
          value: parsed.value,
          senderUserId,
          senderRole,
          ts: Date.now(),
        };
        socket.to(`session:${roomId}`).emit('main-out-update', payload);
        socket.emit('main-out-update', payload);
      });

      socket.on('leave-session', () => {
        refreshIdleTimer();
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const userId = String(socket.data?.sessionUserId ?? '');
        // K-5/COLLAB-P0-001: Locks des Users beim Verlassen freigeben.
        const released = authoritativeSession.releaseUserLocks(userId);
        for (const pluginId of released) {
          socket.to(`session:${roomId}`).emit('plugin-unlock', { pluginId, userId, reason: 'left' });
        }
        persistSessionState();
        if (released.includes('mixer')) broadcastMainOutOwner(`session:${roomId}`);
        socket.to(`session:${roomId}`).emit('peer-left', { roomId, socketId: socket.id, userId: socket.data?.sessionUserId });
        socket.leave(`session:${roomId}`);
      });

      socket.on('disconnect', () => {
        const roomId = socket.data?.sessionRoom;
        if (!roomId) return;
        const userId = String(socket.data?.sessionUserId ?? '');
        // K-5: Locks des getrennten Users sofort freigeben und verteilen.
        const released = authoritativeSession.releaseUserLocks(userId);
        for (const pluginId of released) {
          socket.to(`session:${roomId}`).emit('plugin-unlock', { pluginId, userId, reason: 'disconnect' });
        }
        persistSessionState();
        if (released.includes('mixer')) broadcastMainOutOwner(`session:${roomId}`);
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
          // S-5: sessionId strikt whitelisten (kein Path/Namespace-Injection in Raumnamen).
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) {
            socket.disconnect(true);
            return;
          }
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
            } catch (e) { console.warn('[sfu] operation failed:', (e as Error).message); cb?.({ error: 'internal' }); }
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
            } catch (e) { console.warn('[sfu] operation failed:', (e as Error).message); cb?.({ error: 'internal' }); }
          });
          socket.on('connectTransport', async (data: any, cb: any) => {
            try {
              const t = transports.get(String(data?.transportId ?? ''));
              if (!t) throw new Error('kein transport');
              await t.connect({ dtlsParameters: data.dtlsParameters });
              cb?.({});
            } catch (e) { console.warn('[sfu] operation failed:', (e as Error).message); cb?.({ error: 'internal' }); }
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
            } catch (e) { console.warn('[sfu] operation failed:', (e as Error).message); cb?.({ error: 'internal' }); }
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
            } catch (e) { console.warn('[sfu] operation failed:', (e as Error).message); cb?.({ error: 'internal' }); }
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

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`audioMONASTRY running on http://0.0.0.0:${port}`);
      resolve();
    });
  });
  return { httpServer: server, io };
}

export { app, startServer };

if (
  process.env.VITEST !== 'true' &&
  process.env.NODE_ENV !== 'test' &&
  process.env.AUDIOMONASTRY_NO_AUTOSTART !== '1'
) {
  startServer();
}
