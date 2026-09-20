/**
 * audioMONASTRY · Idle-Shutdown-SignAL (F9-Fix)
 * ============================================
 * Befund (docs/FIXPLAN_2026-09-20_externer_apptest.md, F9): Das Idle-Shutdown-
 * Signal des Hetzner-Timers feuerte gegen ein **Primärsignal, das strukturell
 * immer 0 war**; das Log zeigte ausnahmslos `ONLINE=0`.
 *
 * Wie das Signal bisher gebildet wurde (Belegstelle, Vorzustand):
 * `scripts/hetzner/systemd/idle-check.sh`, Zeilen 35-38 -
 *   `curl -fsS --max-time 5 http://127.0.0.1/api/online | awk -F'"online":' ...`
 * Zwei strukturelle Fehler in EINER Zeile:
 *   * Port 80 = Caddy, und Caddy antwortet einem Klartext-`http://`-Aufruf mit
 *     **308** auf https — der Body ist leer, `awk` liest nichts und druckt die 0
 *     des `END`-Blocks. Exit-Code bleibt 0, der Fehler ist unsichtbar.
 *   * In Produktion verlangt `/api/online` den Studio-/Scrape-Token. Ohne Token
 *     kommt ein **401**; mit `-f` schlägt curl fehl, `|| echo 0` setzt ebenfalls 0.
 * Ergebnis: `ONLINE=0` in jeder Zeile. Die Entscheidung hing faktisch allein an
 * `HTTP_ACTIVE` (etablierte TCP-Verbindungen auf 80/443/8080) — also an
 * Keep-Alive-Verbindungen von Monitoring/Caddy, nicht an App-Nutzung.
 *
 * Dieses Modul macht daraus EINE reine, testbare Entscheidung:
 *   idle  ⇔  keine offenen Sockets
 *        UND kein aktiver Socket-Client (`/api/online`)
 *        UND kein erfolgreicher App-Request innerhalb der Schwelle
 *        UND keine SSH-Session/kein Last-/Container-Job
 * Ist das App-Signal nicht lesbar (kein 200), lautet der Verdikt `unknown`:
 * **kein Shutdown** (fail-safe) — lieber eine Nacht Kosten als eine laufende
 * Session abschießen.
 */
import type { SocketLivenessEvaluation } from './socketLiveness.ts';

/** Fallback-Schwelle, wenn weder Request noch Env eine nennen. */
export const DEFAULT_IDLE_SHUTDOWN_MINUTES = 30;

/**
 * Pfade, die KEINE App-Nutzung sind: Monitoring, Alarme und der Idle-Abruf
 * selbst. Sie dürfen den Zeitstempel "letzte echte App-Nutzung" nicht
 * weiterschieben — sonst hält sich die Instanz über Prometheus-Scrapes selbst
 * wach (der Beobachtungsfall aus F9 in der Gegenrichtung).
 */
export const IDLE_MONITORING_PATHS: readonly string[] = [
  '/api/health',
  '/api/metrics',
  '/api/online',
  '/api/idle-signal',
  '/api/audit',
  '/api/security/csp-report',
  '/api/alerts/webhook',
];

/** Ist dieser Request eine echte App-Nutzung? (Pfadvergleich ohne Query.) */
export function isAppActivityRequest(method: string, pathOrUrl: string): boolean {
  const method_ = String(method || '').toUpperCase();
  if (method_ === 'HEAD' || method_ === 'OPTIONS') return false;
  const path = String(pathOrUrl || '').split('?')[0];
  if (!path) return false;
  return !IDLE_MONITORING_PATHS.includes(path);
}

export interface IdleSignalFacts {
  nowMs: number;
  /** Aktive Socket.io-Verbindungen (Registry-Wahrheit, siehe socketLiveness.ts). */
  onlineSockets: number;
  /** Host-Ebene: etablierte TCP-Verbindungen auf App-/Proxy-Ports (`ss`). */
  openSockets: number;
  sshSessions: number;
  load1: number;
  busyContainers: number;
  /** Letzter erfolgreicher App-Request (ms epoch); null = seit Prozessstart keiner. */
  lastActivityAtMs: number | null;
  /** Prozessstart — Fallback-Zeitbasis, wenn noch kein Request ankam. */
  startedAtMs: number;
  idleThresholdMs: number;
  /** War das App-Signal lesbar (HTTP 200)? false ⇒ verdict 'unknown'. */
  signalOk: boolean;
}

export type IdleVerdict = 'active' | 'idle' | 'unknown';

export interface IdleSignalEvaluation {
  verdict: IdleVerdict;
  /** true nur bei verdict === 'idle'. */
  idle: boolean;
  /** Was gerade "aktiv" gemeldet hat — im Log nachlesbar. */
  reasons: string[];
  /** Alter des letzten erfolgreichen App-Requests in ms. */
  activityAgeMs: number;
}

const seconds = (ms: number): number => Math.max(0, Math.round(ms / 1000));

/**
 * Reine Bewertung EINES Zeitpunkts: ist gerade Nutzung messbar?
 * `unknown` = das primäre Signal war nicht lesbar (fail-safe, kein Shutdown).
 */
export function evaluateIdleSignal(facts: IdleSignalFacts): IdleSignalEvaluation {
  const ageMs = Math.max(0, facts.nowMs - (facts.lastActivityAtMs ?? facts.startedAtMs));
  if (!facts.signalOk) {
    return { verdict: 'unknown', idle: false, reasons: ['app-signal-unreadable'], activityAgeMs: ageMs };
  }

  const reasons: string[] = [];
  if (facts.onlineSockets > 0) reasons.push(`online-sockets=${facts.onlineSockets}`);
  if (facts.openSockets > 0) reasons.push(`offene-sockets=${facts.openSockets}`);
  if (facts.sshSessions > 0) reasons.push(`ssh-sessions=${facts.sshSessions}`);
  if (facts.load1 >= 1) reasons.push(`load1=${facts.load1}`);
  if (facts.busyContainers > 0) reasons.push(`busy-containers=${facts.busyContainers}`);
  if (ageMs < facts.idleThresholdMs) reasons.push(`request-vor-${seconds(ageMs)}s`);

  if (reasons.length > 0) return { verdict: 'active', idle: false, reasons, activityAgeMs: ageMs };
  return { verdict: 'idle', idle: true, reasons: ['keine-nutzung'], activityAgeMs: ageMs };
}

export interface IdleDecisionInput {
  evaluation: IdleSignalEvaluation;
  idleForMs: number;
  idleThresholdMs: number;
}

export interface IdleDecision {
  shutdown: boolean;
  reason: string;
}

/** Reine Entscheidung: Shutdown nur bei idle UND voller Schwelle. */
export function decideIdleShutdown(input: IdleDecisionInput): IdleDecision {
  if (input.evaluation.verdict === 'unknown') {
    return { shutdown: false, reason: 'app-signal-unlesbar (fail-safe: kein Shutdown)' };
  }
  if (!input.evaluation.idle) {
    return { shutdown: false, reason: `aktiv: ${input.evaluation.reasons.join(', ')}` };
  }
  if (input.idleForMs < input.idleThresholdMs) {
    return {
      shutdown: false,
      reason: `idle seit ${seconds(input.idleForMs)}s < Schwelle ${seconds(input.idleThresholdMs)}s`,
    };
  }
  return { shutdown: true, reason: `idle seit ${seconds(input.idleForMs)}s >= Schwelle ${seconds(input.idleThresholdMs)}s` };
}

export interface IdleLogInput {
  nowMs: number;
  facts: IdleSignalFacts;
  evaluation: IdleSignalEvaluation;
  idleForMs: number;
  decision: IdleDecision;
}

const iso = (ms: number | null): string => (ms === null ? 'nie' : new Date(ms).toISOString());

/**
 * Eine Log-Zeile mit ECHTEN Zahlen und Zeitstempeln — genau das fehlte im
 * Vorzustand (`ONLINE=0` ohne Aussage, ohne HTTP-Status, ohne Zeitbezug).
 * Aufbau bewusst stabil: `field=value`, damit grep/Auswertung greift.
 */
export function formatIdleLogLine(input: IdleLogInput): string {
  const { facts, evaluation, decision } = input;
  return [
    `[idle-check] ${iso(input.nowMs)}`,
    `ONLINE=${facts.onlineSockets}`,
    `OPEN_SOCKETS=${facts.openSockets}`,
    `SSH=${facts.sshSessions}`,
    `LOAD1=${facts.load1}`,
    `BUSY_CONTAINERS=${facts.busyContainers}`,
    `LAST_ACTIVITY=${iso(facts.lastActivityAtMs)}`,
    `ACTIVITY_AGE=${seconds(evaluation.activityAgeMs)}s`,
    `IDLE_FOR=${seconds(input.idleForMs)}s`,
    `THRESHOLD=${seconds(facts.idleThresholdMs)}s`,
    `VERDICT=${evaluation.verdict}`,
    `SHUTDOWN=${decision.shutdown ? 'yes' : 'no'}`,
    `REASON="${decision.reason}"`,
  ].join(' ');
}

export interface IdleWatchResult {
  facts: IdleSignalFacts;
  evaluation: IdleSignalEvaluation;
  idleForMs: number;
  decision: IdleDecision;
  logLine: string;
}

export interface IdleWatcher {
  /** Bewertet einen Abruf und führt die Idle-Dauer über Abrufe hinweg mit. */
  evaluate(facts: IdleSignalFacts): IdleWatchResult;
  idleSinceMs(): number | null;
  reset(): void;
  lastResult(): IdleWatchResult | null;
}

/**
 * Laufzeit: hält NUR `idleSince` — die Idle-Dauer ergibt sich aus Zeitstempeln,
 * nicht aus einem Zählerfile. Deshalb braucht der Timer auf dem Knoten keinen
 * Zustand mehr zu führen (ein Ort weniger, der driften kann) und ein Neustart der
 * App setzt die Uhr sauber zurück.
 */
export function createIdleWatcher(options: { now?: () => number } = {}): IdleWatcher {
  const readNow = options.now ?? (() => Date.now());
  let idleSince: number | null = null;
  let last: IdleWatchResult | null = null;

  return {
    evaluate(facts) {
      const now = Number.isFinite(facts.nowMs) ? facts.nowMs : readNow();
      const normalized: IdleSignalFacts = { ...facts, nowMs: now };
      const evaluation = evaluateIdleSignal(normalized);
      if (evaluation.idle) idleSince = idleSince ?? now;
      else idleSince = null;
      const idleForMs = evaluation.idle && idleSince !== null ? Math.max(0, now - idleSince) : 0;
      const decision = decideIdleShutdown({ evaluation, idleForMs, idleThresholdMs: normalized.idleThresholdMs });
      last = {
        facts: normalized,
        evaluation,
        idleForMs,
        decision,
        logLine: formatIdleLogLine({ nowMs: now, facts: normalized, evaluation, idleForMs, decision }),
      };
      return last;
    },
    idleSinceMs: () => idleSince,
    reset() { idleSince = null; last = null; },
    lastResult: () => last,
  };
}

/**
 * Schwelle auflösen: explizite Angabe des Timers (`IDLE_MINUTES`) schlägt den
 * Env-Default der App. Zwei Orte für dieselbe Zahl waren bereits ein Audit-Befund
 * (docs/audit-infra-hetzner.md, M10) — deshalb EINE Auflösungsfunktion.
 */
export function resolveIdleThresholdMs(
  overrideSeconds: unknown,
  envMinutes: unknown = process.env.IDLE_SHUTDOWN_MINUTES,
): number {
  const override = Number(overrideSeconds);
  if (Number.isFinite(override) && override > 0) return Math.round(override * 1000);
  const minutes = Number(envMinutes);
  const effective = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_SHUTDOWN_MINUTES;
  return Math.round(effective * 60 * 1000);
}

export interface IdleHostFacts {
  openSockets: number;
  sshSessions: number;
  load1: number;
  busyContainers: number;
  thresholdSeconds: number | null;
}

const nonNegativeNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Host-Fakten aus den Query-Parametern des Timers. Bewusst tolerant (der Timer
 * läuft auf fremden Knoten mit anderen Tools): unlesbare Werte werden zu 0 —
 * aber NIE stillschweigend zu "aktiv", die Entscheidung selbst bleibt sichtbar.
 */
export function parseIdleHostFacts(query: Record<string, unknown> = {}): IdleHostFacts {
  const threshold = Number(query.thresholdSec);
  return {
    openSockets: nonNegativeNumber(query.openSockets),
    sshSessions: nonNegativeNumber(query.sshSessions),
    load1: nonNegativeNumber(query.load1),
    busyContainers: nonNegativeNumber(query.busyContainers),
    thresholdSeconds: Number.isFinite(threshold) && threshold > 0 ? threshold : null,
  };
}

/** Verdichtete Sicht für die Antwort (JSON) — dieselben Zahlen wie im Log. */
export function summarizeIdleResult(result: IdleWatchResult, extra: { onlineSockets: number; socketEvaluation?: SocketLivenessEvaluation | null }): Record<string, unknown> {
  const { facts, evaluation, decision } = result;
  return {
    ts: new Date(facts.nowMs).toISOString(),
    verdict: evaluation.verdict,
    idle: evaluation.idle,
    shutdown: decision.shutdown,
    reason: decision.reason,
    reasons: evaluation.reasons,
    online: extra.onlineSockets,
    openSockets: facts.openSockets,
    sshSessions: facts.sshSessions,
    load1: facts.load1,
    busyContainers: facts.busyContainers,
    lastActivityAt: facts.lastActivityAtMs === null ? null : new Date(facts.lastActivityAtMs).toISOString(),
    activityAgeSec: seconds(evaluation.activityAgeMs),
    idleForSec: seconds(result.idleForMs),
    idleThresholdSec: seconds(facts.idleThresholdMs),
    socketGhosts: extra.socketEvaluation?.ghosts.length ?? 0,
    logLine: result.logLine,
  };
}
