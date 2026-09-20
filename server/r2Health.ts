/**
 * audioMONASTRY · Echter R2-Probe-Healthcheck + Fehlerklassifikation (FIX F2)
 * ===========================================================================
 * Der Befund (externer App-Test 2026-09-20, F2) hatte zwei Hälften:
 *
 *   1. `/api/cloud/health` meldete für R2 nur „Credentials vorhanden“ bzw. den
 *      rohen SDK-Fehlertext – der Zustand war im Betrieb NICHT sichtbar, nur im
 *      Log (20× `SignatureDoesNotMatch` beim Autosave).
 *   2. „Vorhanden“ ist keine Aussage über Funktion. Ein falsches Paar fällt erst
 *      beim ersten echten Schreibzugriff auf.
 *
 * Dieses Modul prüft deshalb ein ECHTES Probeobjekt (PUT + DELETE eines kleinen
 * Keys mit hartem Timeout) und macht das Ergebnis zu einem Betriebszustand:
 * `state = ok | degraded | error | unconfigured`, sichtbar in `/api/cloud/health`
 * UND als `cloud.r2` in `/api/metrics`. Fehler werden klassifiziert
 * (`signature-mismatch`, `timeout`, …) statt als Freitext durchgereicht.
 *
 * Log-Verhalten: EINE Warnung je Fehlerklasse (aufsteigend gezählt) statt Flut.
 * Wiederholungen werden unterdrückt und gezählt; erholt sich R2, wird die
 * Unterdrückung zurückgesetzt, damit ein neuer Ausfall wieder eine Warnung ergibt.
 *
 * Kein Netzwerk in Tests: Client-Fabrik (`createClient`) ist injizierbar; der
 * Standardweg geht über den echten `S3Client` (Tests nutzen einen lokalen Stub).
 */
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  describeR2Source,
  formatR2DeviationWarning,
  resolveR2Config,
  type R2Config,
  type R2Env,
} from './r2Config';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export type R2State = 'ok' | 'degraded' | 'error' | 'unconfigured' | 'unknown';

export type R2ProblemCode =
  | 'not-configured'
  | 'credentials-shape'
  | 'signature-mismatch'
  | 'invalid-access-key'
  | 'access-denied'
  | 'no-such-bucket'
  | 'bucket-missing'
  | 'timeout'
  | 'unreachable'
  | 'http-error'
  | 'probe-failed';

export interface R2ProbeResult {
  ok: boolean;
  problem: R2ProblemCode | null;
  message: string | null;
  durationMs: number;
  attempts: number;
  key: string | null;
  bucket: string | null;
  endpointHost: string | null;
  method: 'PUT+DELETE' | 'none';
}

export interface R2HealthSnapshot extends R2ProbeResult {
  /** Normalisierter Zustand (neu; Grundlage für Metriken und den Ladebildschirm). */
  state: R2State;
  /**
   * Kompatibilitätsfeld für bestehende Consumer (`CloudStatusBadge`,
   * `tests/server.test.ts`): `ok` | `not-configured` | `error: …`.
   * `not-configured` entspricht `state: 'unconfigured'`.
   */
  status: string;
  checkedAt: number | null;
  credentials: {
    source: string;
    configured: boolean;
    usedEnvKeys: string[];
    ignoredEnvKeys: string[];
    deviationCount: number;
    deviation: R2DeviationInfo[];
    problems: string[];
  };
}

export interface R2DeviationInfo {
  field: string;
  chosen: string;
  values: { name: string; fingerprint: string; length: number }[];
}

/** Betriebszustand eines R2-Schreibpfads (Autosave/Upload). */
export interface R2WriteStatus {
  state: R2State;
  lastOkAt: number | null;
  lastFailureAt: number | null;
  failures: number;
  lastProblem: R2ProblemCode | null;
  lastMessage: string | null;
  attempts: number;
}

export interface R2CloudStatus {
  r2: R2HealthSnapshot;
  writes: Record<'autosave' | 'upload', R2WriteStatus>;
  /** Kurzform für den Autosave-Pfad (F2/c). */
  autosave: R2WriteStatus;
}

/** Minimal-Schnittstelle des S3-Clients, die der Probe braucht (Test-Double-fähig). */
export interface R2ClientLike {
  send(command: unknown, options?: { abortSignal?: AbortSignal; requestTimeout?: number }): Promise<unknown>;
}

export interface R2ProbeOptions {
  timeoutMs?: number;
  /** Key-Präfix im Bucket (Default `probes/`). */
  keyPrefix?: string;
  now?: () => number;
  createClient?: (config: R2Config, opts: { maxAttempts: number }) => R2ClientLike;
  bucketOverride?: string;
}

// ---------------------------------------------------------------------------
// Grenzen und Zustand (Modul-Singleton – wie `aiOrchestrator` in opsRoutes)
// ---------------------------------------------------------------------------

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_KEY_PREFIX = 'probes/';

/** TTL des letzten Probeergebnisses (Env überschreibbar, 0 = immer messen). */
function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function r2ProbeTimeoutMs(): number {
  return Math.max(250, envInt('R2_PROBE_TIMEOUT_MS', DEFAULT_PROBE_TIMEOUT_MS));
}

export function r2HealthTtlMs(): number {
  return envInt('R2_HEALTH_TTL_MS', DEFAULT_TTL_MS);
}

let lastSnapshot: R2HealthSnapshot | null = null;
let inflightProbe: Promise<R2HealthSnapshot> | null = null;
let probeRuns = 0;
let probeFailures = 0;

// ---------------------------------------------------------------------------
// Log-Drosselung: EINE Warnung je Signatur
// ---------------------------------------------------------------------------

interface LogEntry {
  count: number;
  firstAt: number;
  lastAt: number;
  message: string;
}

const logRegistry = new Map<string, LogEntry>();

/**
 * Loggt eine Meldung nur beim ERSTEN Auftreten einer Signatur.
 *
 * Warum: Der Live-Befund war eine Log-Flut aus identischen Zeilen (20×
 * `SignatureDoesNotMatch`). Eine dauerhaft kaputte Konfiguration ist EIN
 * Betriebszustand, kein 20-facher Vorfall. Wiederholungen werden gezählt und
 * über `/api/metrics` sichtbar gemacht, nicht wiederholt geloggt.
 *
 * @returns true, wenn tatsächlich geloggt wurde.
 */
export function logR2Once(signature: string, message: string, level: 'error' | 'warn' = 'error'): boolean {
  const now = Date.now();
  const existing = logRegistry.get(signature);
  if (existing) {
    existing.count += 1;
    existing.lastAt = now;
    return false;
  }
  logRegistry.set(signature, { count: 1, firstAt: now, lastAt: now, message });
  if (level === 'error') console.error(message);
  else console.warn(message);
  return true;
}

/** Anzahl unterdrückter Wiederholungen einer Signatur (0 = nie gesehen). */
export function suppressedR2LogCount(signature: string): number {
  const entry = logRegistry.get(signature);
  return entry ? entry.count - 1 : 0;
}

// ---------------------------------------------------------------------------
// Fehlerklassifikation
// ---------------------------------------------------------------------------

interface SdkErrorLike {
  name?: string;
  Code?: string;
  code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
  cause?: { code?: string; message?: string };
}

const NETWORK_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EPROTO', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'];

/**
 * Übersetzt einen SDK-/Netzwerkfehler in einen stabilen Problem-Code.
 * Der Name ist Teil der API (`ingest`-Pfade, Tests, Ops-Skript) – die Message
 * bleibt ergänzend, aber nie die einzige Information.
 */
export function classifyR2Problem(error: unknown): { problem: R2ProblemCode; message: string } {
  const err = (error ?? {}) as SdkErrorLike;
  const name = String(err.name ?? err.Code ?? err.code ?? '');
  const message = String(err.message ?? error ?? 'unbekannter Fehler');
  const status = err.$metadata?.httpStatusCode;
  const networkCode = String(err.code ?? err.cause?.code ?? '');

  if (name === 'TimeoutError' || name === 'AbortError' || /aborted|timed out|timeout/i.test(message)) {
    return { problem: 'timeout', message };
  }
  if (/signature we calculated does not match|SignatureDoesNotMatch/i.test(`${name} ${message}`)) {
    return { problem: 'signature-mismatch', message };
  }
  if (name === 'InvalidAccessKeyId' || /invalid access key/i.test(message)) {
    return { problem: 'invalid-access-key', message };
  }
  if (name === 'NoSuchBucket') {
    return { problem: 'no-such-bucket', message };
  }
  if (name === 'AccessDenied' || status === 403) {
    return { problem: 'access-denied', message };
  }
  if (NETWORK_CODES.includes(networkCode) || /getaddrinfo|socket hang up|fetch failed/i.test(message)) {
    return { problem: 'unreachable', message };
  }
  if (typeof status === 'number' && status >= 500) {
    return { problem: 'http-error', message: `HTTP ${status}: ${message}` };
  }
  return { problem: 'probe-failed', message };
}

/**
 * Wiederholbar? Ein Signatur-/Rechte-Fehler kann sich durch Wiederholen NICHT
 * heilen – genau diese Wiederholungen erzeugten die beobachtete Log-Flut.
 * Transportfehler (Timeout, DNS, 5xx) sind dagegen retry-fähig.
 */
export function isRetryableR2Problem(problem: R2ProblemCode | null): boolean {
  return problem === 'timeout' || problem === 'unreachable' || problem === 'http-error';
}

/**
 * Für jede Fehlerklasse die passende Betreiber-Anweisung (deutsch, ohne Werte).
 */
export function r2ProblemHint(problem: R2ProblemCode | null): string {
  switch (problem) {
    case 'not-configured':
      return 'Keine R2-Zugangsdaten in der Knoten-`.env` – Upload/Autosave laufen lokal, /api/metrics zeigt cloud.r2 unconfigured.';
    case 'credentials-shape':
      return 'Zugangspaar vorhanden, aber Format falsch (Access Key 32 Hex, Secret 64 Hex) – prüfen, ob der Wert nicht abgeschnitten/mit Anführungszeichen kopiert wurde.';
    case 'signature-mismatch':
      return 'Access Key und Secret passen nicht zum Bucket/Endpoint. R2-API-Token-Paar im Portal-Secret UND in der Knoten-`.env` auf dasselbe Paar setzen (docs/OPS_RUNBOOK.md, Abschnitt „R2 (F2)“).';
    case 'invalid-access-key':
      return 'Access Key ID existiert im R2-Konto nicht (gelöschtes/rotiertes Token). Neues R2-API-Token erzeugen und beide Quellen aktualisieren.';
    case 'access-denied':
      return 'Rechte fehlen: Das R2-API-Token braucht Object Read & Write für den Bucket.';
    case 'no-such-bucket':
    case 'bucket-missing':
      return 'Bucket existiert nicht bzw. ist nicht gesetzt – CFS3_BUCKET prüfen.';
    case 'timeout':
      return 'Probe lief in den Timeout – Endpoint/Firewall (ausgehend 443) prüfen.';
    case 'unreachable':
      return 'Endpoint nicht erreichbar (DNS/Routing) – CFS3_ENDPOINT prüfen.';
    case 'http-error':
      return 'R2 antwortete mit 5xx – vorübergehend; bei Dauerzustand Cloudflare-Status prüfen.';
    default:
      return 'Unbekannter R2-Fehler – Details siehe Meldung.';
  }
}

/**
 * Typisierter R2-Schreibfehler.
 *
 * Warum eine eigene Klasse: `/api/session/autosave`, `/api/upload/sample` und
 * `/api/cloud/upload` müssen denselben Fehler GLEICH einordnen (Retry ja/nein,
 * 502 vs. 503, sichtbarer Grund). Vorher entschied jede Route per
 * `message.includes('R2 not configured')` – und ein `SignatureDoesNotMatch`
 * wurde als generischer 500 mit rohem SDK-Text durchgereicht.
 */
export class R2WriteError extends Error {
  readonly problem: R2ProblemCode;
  attempts: number;

  constructor(problem: R2ProblemCode, message: string, attempts = 1) {
    super(message);
    this.name = 'R2WriteError';
    this.problem = problem;
    this.attempts = attempts;
  }
}

/** Übersetzt einen beliebigen Wurf aus dem R2-Schreibpfad in einen `R2WriteError`. */
export function toR2WriteError(error: unknown, attempts = 1): R2WriteError {
  if (error instanceof R2WriteError) {
    error.attempts = Math.max(error.attempts, attempts);
    return error;
  }
  const message = error instanceof Error ? error.message : String(error ?? 'unbekannter Fehler');
  // Konfigurationsfehler aus server/cloud.ts – bewusst dieselben Formulierungen
  // wie vor dem Fix, damit bestehende Consumer (Tests, Portal) weiter greifen.
  if (/R2 not configured/i.test(message)) {
    return new R2WriteError('not-configured', message, attempts);
  }
  if (/CFS3_BUCKET missing|CFR2_BUCKET missing/i.test(message)) {
    return new R2WriteError('bucket-missing', message, attempts);
  }
  const classified = classifyR2Problem(error);
  return new R2WriteError(classified.problem, classified.message, attempts);
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** Zufälliger, kollisionsarmer Probe-Key (sicher für `uploads`-Key-Regeln). */
function probeObjectKey(prefix = DEFAULT_KEY_PREFIX, now: () => number = () => Date.now()): string {
  const stamp = now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}r2-health-${stamp}-${rand}.json`;
}

/** Wirft bei Ablauf einen `TimeoutError` – unabhängig davon, ob der Handler den Abort beachtet. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`R2-Probe nach ${timeoutMs} ms abgebrochen`);
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);
  });
  // Der Verlierer des Rennens darf keinen unbehandelten Rejection auslösen.
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Standard-Client für die Probe: EIN Versuch, damit die Probe schnell und ohne stilles Wiederholen bleibt. */
export function createProbeClient(config: R2Config, opts: { maxAttempts: number }): R2ClientLike {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: opts.maxAttempts,
  }) as unknown as R2ClientLike;
}

/**
 * Führt den echten Probe-Schreibvorgang aus: PUT eines wenige Bytes großen
 * Objekts, danach DELETE desselben Keys. Ein erfolgreicher PUT beweist
 * Signatur, Bucket und Schreibrecht; das DELETE hält den Bucket sauber.
 */
export async function probeR2(config: R2Config, options: R2ProbeOptions = {}): Promise<R2ProbeResult> {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? r2ProbeTimeoutMs();
  const bucket = options.bucketOverride ?? config.bucket;

  const empty = (problem: R2ProblemCode, message: string): R2ProbeResult => ({
    ok: false,
    problem,
    message,
    durationMs: 0,
    attempts: 0,
    key: null,
    bucket: bucket || null,
    endpointHost: endpointHost(config),
    method: 'none',
  });

  if (config.problems.includes('access-key-shape') || config.problems.includes('secret-shape')) {
    return empty('credentials-shape', 'R2-Zugangspaar hat ein ungültiges Format (Access Key 32 Hex, Secret 64 Hex).');
  }
  if (!config.hasCredentials) {
    return empty('not-configured', 'Keine R2-Zugangsdaten gesetzt.');
  }
  if (!bucket) return empty('bucket-missing', 'CFS3_BUCKET/CFR2_BUCKET ist nicht gesetzt.');
  if (!config.endpoint) return empty('not-configured', 'Kein R2-Endpoint auflösbar (CFS3_ENDPOINT/CFR2_ACCOUNT_ID fehlt).');

  const createClient = options.createClient ?? createProbeClient;
  const client = createClient(config, { maxAttempts: 1 });
  const key = probeObjectKey(options.keyPrefix ?? DEFAULT_KEY_PREFIX, now);
  const started = now();
  let attempts = 0;

  try {
    attempts += 1;
    await withTimeout(
      client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify({ probe: 'audiomonastry-r2-health', at: new Date(started).toISOString() }),
        ContentType: 'application/json',
      }), { abortSignal: AbortSignal.timeout(timeoutMs), requestTimeout: timeoutMs }),
      timeoutMs,
    );
  } catch (error) {
    const { problem, message } = classifyR2Problem(error);
    return {
      ok: false,
      problem,
      message,
      durationMs: now() - started,
      attempts,
      key,
      bucket,
      endpointHost: endpointHost(config),
      method: 'PUT+DELETE',
    };
  }

  // Aufräumen: Das Probeobjekt darf nicht liegen bleiben. Ein fehlgeschlagenes
  // DELETE macht den Schreibnachweis NICHT ungültig (PUT hat signiert und
  // geschrieben) – es wird als Hinweis gemeldet, nicht als Fehler gewertet.
  let deleteWarning: string | null = null;
  try {
    await withTimeout(
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(timeoutMs),
        requestTimeout: timeoutMs,
      }),
      timeoutMs,
    );
  } catch (error) {
    deleteWarning = `Probeobjekt ${key} konnte nicht gelöscht werden: ${(error as Error)?.message ?? 'unbekannt'}`;
    logR2Once(`r2:probe-cleanup`, `[cloud] WARNUNG: ${deleteWarning}`, 'warn');
  }

  return {
    ok: true,
    problem: null,
    message: deleteWarning,
    durationMs: now() - started,
    attempts,
    key,
    bucket,
    endpointHost: endpointHost(config),
    method: 'PUT+DELETE',
  };
}

function endpointHost(config: R2Config): string | null {
  if (!config.endpoint) return null;
  try {
    return new URL(config.endpoint).host;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Health-Lauf (TTL-Cache + Single-Flight) und Status
// ---------------------------------------------------------------------------

function credentialInfo(config: R2Config): R2HealthSnapshot['credentials'] {
  return {
    source: describeR2Source(config),
    configured: config.configured,
    usedEnvKeys: config.usedEnvKeys,
    ignoredEnvKeys: config.ignoredEnvKeys,
    deviationCount: config.deviation.length,
    deviation: config.deviation.map((d) => ({
      field: d.field,
      chosen: d.chosen,
      values: d.values.map((v) => ({ name: v.name, fingerprint: v.fingerprint, length: v.length })),
    })),
    problems: config.problems,
  };
}

function snapshotFromProbe(config: R2Config, probe: R2ProbeResult, now: () => number): R2HealthSnapshot {
  const credentials = credentialInfo(config);
  const writeReady = config.hasCredentials && Boolean(config.bucket) && Boolean(config.endpoint);
  const unconfiguredProblem = probe.problem === 'not-configured' || probe.problem === 'bucket-missing' || probe.problem === 'credentials-shape';

  let state: R2State;
  let status: string;

  if (!writeReady || unconfiguredProblem) {
    // `not-configured` bleibt der Kompatibilitätsname für „nicht einsatzbereit“:
    // fehlende Credentials, fehlender Bucket oder falsches Key-Format. Bewusst
    // NICHT 'ok' – das war der Fehler im Live-Betrieb („Credentials vorhanden“
    // galt als gesund).
    state = 'unconfigured';
    status = 'not-configured';
  } else if (probe.ok && config.deviation.length === 0) {
    state = 'ok';
    status = 'ok';
  } else if (probe.ok) {
    // Schreiben funktioniert, aber zwei Quellen widersprechen sich: das ist ein
    // Betriebszustand mit Ansage (die nächste Rotation kippt eine der beiden).
    state = 'degraded';
    status = 'degraded: credential-source-deviation';
  } else {
    state = 'degraded';
    status = `error: ${probe.message ?? probe.problem ?? 'unbekannt'}`;
  }

  return {
    ...probe,
    ok: state === 'ok',
    state,
    status,
    checkedAt: now(),
    credentials,
  };
}

/** Vorbereiteter „nicht konfiguriert“-Snapshot ohne Probeversuch. */
function unconfiguredSnapshot(config: R2Config, now: () => number): R2HealthSnapshot {
  return snapshotFromProbe(config, {
    ok: false,
    problem: 'not-configured',
    message: 'Keine R2-Zugangsdaten konfiguriert (CFS3_ACCESS_KEY/CFS3_SECRET_KEY bzw. CFR2_* fehlen).',
    durationMs: 0,
    attempts: 0,
    key: null,
    bucket: config.bucket || null,
    endpointHost: endpointHost(config),
    method: 'none',
  }, now);
}

export interface RunR2HealthCheckOptions extends R2ProbeOptions {
  env?: R2Env;
  /** true = TTL-Cache ignorieren (Operator-Aufruf `?probe=1`). */
  force?: boolean;
}

/**
 * Liefert den R2-Zustand – mit Probeobjekt, Timeout und TTL-Cache.
 *
 * Der Cache ist bewusst gesetzt: `/api/cloud/health` wird vom Portal-Ladebild
 * und den Smoke-Tests gepollt; ohne TTL würde jede Abfrage ein PUT/DELETE in R2
 * auslösen. `force` (Query `?probe=1`) misst immer neu.
 */
export async function runR2HealthCheck(options: RunR2HealthCheckOptions = {}): Promise<R2HealthSnapshot> {
  const now = options.now ?? (() => Date.now());
  const env = options.env ?? process.env;
  const config = resolveR2Config(env);

  if (!config.hasCredentials) {
    const snapshot = unconfiguredSnapshot(config, now);
    lastSnapshot = snapshot;
    logMissingCredentialsOnce(config);
    return snapshot;
  }

  const ttl = r2HealthTtlMs();
  if (!options.force && lastSnapshot && ttl > 0 && lastSnapshot.checkedAt !== null && now() - lastSnapshot.checkedAt < ttl) {
    return lastSnapshot;
  }
  if (inflightProbe) return inflightProbe;

  const run = (async () => {
    probeRuns += 1;
    const probe = await probeR2(config, options);
    const snapshot = snapshotFromProbe(config, probe, now);
    if (!probe.ok) probeFailures += 1;
    lastSnapshot = snapshot;

    if (config.deviation.length > 0) {
      logR2Once('r2:deviation', `[cloud] R2-KONFIGURATIONSFEHLER: ${formatR2DeviationWarning(config.deviation)}`);
    }
    if (config.ignoredEnvKeys.length > 0) {
      logR2Once(
        'r2:ignored-keys',
        `[cloud] R2: gesetzte, aber unbenutzte Variablen mit abweichendem Wert: ${config.ignoredEnvKeys.join(', ')} `
        + `(benutzt: ${describeR2Source(config)})`,
        'warn',
      );
    }

    if (probe.ok) {
      // Erholung: Unterdrückung zurücksetzen, damit ein neuer Ausfall wieder
      // genau EINE Warnung erzeugt.
      for (const signature of [...logRegistry.keys()]) {
        if (signature.startsWith('r2:')) logRegistry.delete(signature);
      }
      if (snapshot.state === 'degraded') {
        logR2Once('r2:degraded', `[cloud] R2-WARNUNG: Schreibprobe ok, aber die Konfiguration ist widersprüchlich (${config.deviation.length} Abweichung(en)).`, 'warn');
      }
    } else {
      const code = probe.problem ?? 'probe-failed';
      logR2Once(
        `r2:${code}`,
        `[cloud] R2-Healthcheck FEHLGESCHLAGEN [${code}]: ${probe.message ?? 'ohne Meldung'} `
        + `(Quelle: ${describeR2Source(config)}; Bucket: ${config.bucket || 'unbekannt'}; Endpoint: ${endpointHost(config) ?? 'unbekannt'}). `
        + r2ProblemHint(code),
      );
    }
    return snapshot;
  })().finally(() => {
    inflightProbe = null;
  });

  inflightProbe = run;
  return run;
}

function logMissingCredentialsOnce(config: R2Config): void {
  logR2Once(
    'r2:not-configured',
    `[cloud] R2 ist NICHT konfiguriert (${config.problems.join(', ') || 'keine Variablen'}) – `
    + 'Upload/Autosave bleiben lokal, /api/metrics zeigt cloud.r2 unconfigured.',
    'warn',
  );
}

/** Letzter Snapshot bzw. ein „unknown“-Platzhalter (synchron, für Metriken). */
export function getR2HealthSnapshot(): R2HealthSnapshot {
  if (lastSnapshot) return lastSnapshot;
  return {
    ok: false,
    problem: null,
    message: 'noch keine Probe gelaufen',
    durationMs: 0,
    attempts: 0,
    key: null,
    bucket: null,
    endpointHost: null,
    method: 'none',
    state: 'unknown',
    status: 'unknown',
    checkedAt: null,
    credentials: {
      source: 'unbekannt',
      configured: false,
      usedEnvKeys: [],
      ignoredEnvKeys: [],
      deviationCount: 0,
      deviation: [],
      problems: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Schreib-Rückmeldungen (F2/c): Autosave + Upload werden Betriebszustand
// ---------------------------------------------------------------------------

/** Herkunft eines R2-Schreibversuchs (die Pfade, die live fehlschlugen). */
export type R2WriteSource = 'autosave' | 'upload';

export interface R2WriteOutcome {
  ok: boolean;
  problem?: R2ProblemCode | null;
  message?: string | null;
  attempts?: number;
  now?: () => number;
}

const EMPTY_WRITE_STATUS: R2WriteStatus = {
  state: 'unknown',
  lastOkAt: null,
  lastFailureAt: null,
  failures: 0,
  lastProblem: null,
  lastMessage: null,
  attempts: 0,
};

const writeStatus: Record<R2WriteSource, R2WriteStatus> = {
  autosave: { ...EMPTY_WRITE_STATUS },
  upload: { ...EMPTY_WRITE_STATUS },
};

/**
 * Vermerkt das Ergebnis eines R2-Schreibversuchs. Ein dauerhafter R2-Fehler wird
 * damit zum Betriebszustand (`degraded`/`error`) – vorher war er nur im Log
 * sichtbar, während die Route weiter 502 lieferte.
 *
 * Ein Signatur-/Rechte-Fehler ergibt `error` (wiederholen heilt ihn nicht), ein
 * Transportfehler `degraded` (kann sich von selbst erholen).
 */
export function recordR2Write(source: R2WriteSource, outcome: R2WriteOutcome): R2WriteStatus {
  const now = outcome.now ?? (() => Date.now());
  const status = writeStatus[source];
  status.attempts = outcome.attempts ?? status.attempts;
  if (outcome.ok) {
    status.state = 'ok';
    status.lastOkAt = now();
    status.lastProblem = null;
    status.lastMessage = null;
    return { ...status };
  }
  status.failures += 1;
  status.lastFailureAt = now();
  status.lastProblem = outcome.problem ?? 'probe-failed';
  status.lastMessage = outcome.message ?? null;
  status.state = isRetryableR2Problem(status.lastProblem) ? 'degraded' : 'error';
  return { ...status };
}

/** Kurzform für den Autosave-Pfad (F2/c – eigener Name für die Aufrufstelle). */
export function recordAutosaveOutcome(outcome: R2WriteOutcome): R2WriteStatus {
  return recordR2Write('autosave', outcome);
}

/** Teilstatus eines Schreibpfads (synchron). */
export function getR2WriteStatus(source: R2WriteSource): R2WriteStatus {
  return { ...writeStatus[source] };
}

/** Alles, was `/api/metrics` als `cloud` ausgibt. */
export function getCloudStatus(): R2CloudStatus {
  return {
    r2: getR2HealthSnapshot(),
    writes: {
      autosave: getR2WriteStatus('autosave'),
      upload: getR2WriteStatus('upload'),
    },
    // Kompatibilität/Analyse: der Autosave-Status flach mit dabei.
    autosave: getR2WriteStatus('autosave'),
  };
}

/** Zähler für Prometheus (Monotonie bleibt über den Prozess erhalten). */
export function getR2Counters(): { probes: number; failures: number } {
  return { probes: probeRuns, failures: probeFailures };
}

/** Nur für Tests: Modulzustand zurücksetzen (kein Produktionsaufruf). */
export function resetR2HealthForTests(): void {
  lastSnapshot = null;
  inflightProbe = null;
  probeRuns = 0;
  probeFailures = 0;
  logRegistry.clear();
  writeStatus.autosave = { ...EMPTY_WRITE_STATUS };
  writeStatus.upload = { ...EMPTY_WRITE_STATUS };
}
