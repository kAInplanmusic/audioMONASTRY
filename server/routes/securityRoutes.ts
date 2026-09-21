/**
 * audioMONASTRY · Sicherheits-Meldewege (F7-Fix)
 * ==============================================
 *   POST /api/security/csp-report    → Browser-CSP-Verstöße (Content-Security-Policy
 *                                      `report-uri`/`report-to`)
 *   GET  /api/security/csp-reports   → Auswertung der eingegangenen Meldungen
 *                                      (Zähler + Ringpuffer; tokenpflichtig über
 *                                      die normale /api-Auth)
 *
 * Warum eine eigene Datei: Die CSP war `Report-Only` OHNE Meldeziel – Verstöße
 * landeten ausschließlich in der Browser-Konsole des jeweiligen Nutzers, also
 * nirgends, wo ein Betreiber sie sieht. Genau deshalb ließ sich vorher nicht
 * begründet entscheiden, ob die Policy scharf gestellt werden kann.
 *
 * Eigenschaften des Endpunkts:
 *   * **tokenfrei** (wie `/api/health`) – ein Browser sendet CSP-Reports ohne
 *     eigene Header; mit Pflicht-Token wären sie still verloren gegangen. Der
 *     Endpunkt ist deshalb rate-limitiert (siehe server.ts) und schreibt NICHTS
 *     zurück, was einem Angreifer hilft (immer 204).
 *   * **datensparsam**: gespeichert/geloggt werden nur verletzte Direktive und
 *     die HOSTS von blockiertem Ziel und Dokument (`summarizeCspReports`) – keine
 *     vollen URLs, keine Query-Parameter, keine Cookies.
 *   * **begrenzt**: höchstens `MAX_LOGGED` Einträge im Ringpuffer; geloggt wird
 *     je (Direktive, Ziel) höchstens einmal pro Minute, damit ein fehlerhaftes
 *     Deployment nicht das Log flutet.
 *
 * --- F7-Umsetzung: aus „Reports kommen an" wird „Reports sind auswertbar" -----
 * Befund des lokalen Beweislaufs (2026-09-21, echtes Chrome 153 gegen genau
 * diesen Endpunkt): der Endpunkt nahm Meldungen an und antwortete 204, aber
 *   * die MODERNE Form (`application/reports+json`, camelCase-Schlüssel, Array
 *     mit mehreren Verstößen) wurde verworfen, weil nur die Altform gelesen
 *     wurde – und genau die moderne Form schickt Chrome, sobald die Policy
 *     `report-to` nennt (so wie unsere);
 *   * es gab KEINE Ablesestelle: die Zähler lebten nur für Tests
 *     (`getCspViolations()`), ein Betreiber konnte nicht sehen, ob und was
 *     ankommt – die Enforce-Entscheidung wäre weiter blind gewesen.
 * Deshalb zählt dieser Endpunkt jetzt vollständig (je Ausgang und je
 * Direktive/Ziel) und stellt die Zahlen unter `GET /api/security/csp-reports`
 * bereit; dieselben Zähler stehen in `/api/metrics` (Prometheus + JSON), damit
 * die Beobachtung ein Dashboard/eine Alarmregel bekommt statt eines Loggreps.
 */
import type { Express } from 'express';
import express from 'express';
import {
  buildCspPolicy,
  CSP_REPORT_PATH,
  cspViolationTarget,
  resolveCspMode,
  summarizeCspReports,
  type CspMode,
  type CspViolationSummary,
} from '../csp.ts';

/** Höchstzahl der im Speicher gehaltenen Verstöße (Diagnose, kein Archiv). */
export const MAX_LOGGED_CSP_VIOLATIONS = 20;

/** Maximal akzeptierte Report-Größe (Browser senden wenige hundert Bytes). */
export const MAX_CSP_REPORT_BYTES = 32 * 1024;

/** Ablesestelle der Auswertung (tokenpflichtig, siehe Modul-Kommentar). */
export const CSP_REPORTS_STATUS_PATH = '/api/security/csp-reports';

/**
 * Body-Parser NUR für diese Route.
 *
 * Der globale `express.json()` in server.ts akzeptiert ausschließlich
 * `application/json`. Browser senden CSP-Reports aber mit
 * `application/csp-report; charset=utf-8` (report-uri) bzw.
 * `application/reports+json` (Reporting-API/report-to) – ohne eigenen Parser kam
 * jeder ECHTE Report als `undefined` an und wurde verworfen; nur die Tests mit
 * `application/json` wären durchgelaufen (vom Test tests/cspPolicy.test.ts
 * aufgedeckt).
 */
const parseCspReportBody = express.json({
  type: ['application/json', 'application/csp-report', 'application/reports+json'],
  limit: MAX_CSP_REPORT_BYTES,
});

const violations: CspViolationSummary[] = [];
const lastLoggedAt = new Map<string, number>();
const LOG_THROTTLE_MS = 60_000;

/** Zaehler des Meldewegs (Diagnose/Auswertung, keine Nutzerdaten). */
const counters = {
  received: 0,
  violations: 0,
  unusable: 0,
  oversized: 0,
  throttled: 0,
  firstReceivedAt: null as number | null,
  lastReceivedAt: null as number | null,
};
const byDirective = new Map<string, number>();
const byTarget = new Map<string, number>();
const byDocument = new Map<string, number>();

function bump(map: Map<string, number>, key: string): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Map → Objekt, absteigend nach Häufigkeit (stabile Anzeige für den Betreiber). */
function toCounts(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])),
  );
}

export interface CspReportStats {
  /** Laufender Modus der Policy (`report-only` solange der Betreiber nicht umstellt). */
  mode: CspMode;
  /** Header-Name, der tatsächlich gesendet wird (je Modus ein anderer). */
  headerName: string;
  /** POSTs am Meldeendpunkt (ohne die vom Limiter abgewiesenen). */
  received: number;
  /** Erkannte Verstöße – ein POST kann mehrere tragen (Reporting-API-Array). */
  violations: number;
  /** POSTs ohne erkennbaren Verstoß (204, nicht auswertbar). */
  unusable: number;
  /** Verworfene POSTs über `MAX_CSP_REPORT_BYTES`. */
  oversized: number;
  /** Vom eigenen Limiter abgewiesene POSTs (HTTP 429). */
  throttled: number;
  byDirective: Record<string, number>;
  /** Ziel = Host oder CSP-Sonderwert (`inline`, `data`, …). */
  byTarget: Record<string, number>;
  byDocument: Record<string, number>;
  firstReceivedAt: number | null;
  lastReceivedAt: number | null;
  /** Ringpuffer der letzten Verstöße (älteste zuerst). */
  recent: CspViolationSummary[];
}

/** Bisher beobachtete Verstöße (älteste zuerst) – Diagnose/Test. */
export function getCspViolations(): readonly CspViolationSummary[] {
  return violations;
}

/**
 * Vollständige Auswertung des Meldewegs.
 *
 * Die Zähler leben im Prozess: ein Deploy setzt sie zurück. Für die
 * Betreiber-Entscheidung sind deshalb die Prometheus-Zähler in `/api/metrics`
 * maßgeblich (dort erkennt `rate()`/`increase()` auch einen Neustart), die
 * Zähler hier dienen der Ad-hoc-Diagnose direkt nach einem Lauf.
 */
export function getCspReportStats(): CspReportStats {
  const policy = buildCspPolicy(process.env as Record<string, string | undefined>);
  return {
    mode: resolveCspMode(process.env as Record<string, string | undefined>),
    headerName: policy.headerName,
    received: counters.received,
    violations: counters.violations,
    unusable: counters.unusable,
    oversized: counters.oversized,
    throttled: counters.throttled,
    byDirective: toCounts(byDirective),
    byTarget: toCounts(byTarget),
    byDocument: toCounts(byDocument),
    firstReceivedAt: counters.firstReceivedAt,
    lastReceivedAt: counters.lastReceivedAt,
    recent: [...violations],
  };
}

/** Zähler zurücksetzen (Tests und ein bewusstes Neustart der Beobachtung). */
export function resetCspReportStats(): void {
  counters.received = 0;
  counters.violations = 0;
  counters.unusable = 0;
  counters.oversized = 0;
  counters.throttled = 0;
  counters.firstReceivedAt = null;
  counters.lastReceivedAt = null;
  byDirective.clear();
  byTarget.clear();
  byDocument.clear();
  violations.length = 0;
  lastLoggedAt.clear();
}

/**
 * Vom eigenen Limiter abgewiesenen Report zaehlen (429).
 *
 * Wird aus server.ts VOR dem Limiter aufgerufen: der Limiter beendet die
 * Anfrage selbst, ein danach registrierter Zaehler saehe die 429 nie – eine
 * Report-Flut waere dann genau das, was der Meldeweg nicht sichtbar macht.
 */
export function recordThrottledCspReport(): void {
  counters.throttled += 1;
}

export interface SecurityRouteDeps {
  /** Logausgabe (Tests können sie ersetzen). */
  log?: (message: string) => void;
  /** Zeitquelle (Tests). */
  now?: () => number;
}

export function registerSecurityRoutes(app: Express, deps: SecurityRouteDeps = {}): void {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => Date.now());

  // Vom eigenen Limiter abgewiesene Reports werden in server.ts gezaehlt (dort
  // VOR dem Limiter, weil der Limiter die Anfrage selbst beendet).

  app.post(
    CSP_REPORT_PATH,
    (req, res, next) => {
      // Zu große oder unlesbare Bodies werden wie ein unbrauchbarer Report
      // behandelt: der Endpunkt antwortet IMMER 204 und gibt damit auch über
      // Fehlercodes kein Feedback über akzeptierte Formate.
      parseCspReportBody(req, res, () => {
        // Fehler (unlesbares JSON, zu groß für den Parser) = kein Body. Die
        // Unterscheidung passiert unten über die Größe.
        next();
      });
    },
    (req, res) => {
      counters.received += 1;
      counters.lastReceivedAt = now();
      if (counters.firstReceivedAt === null) counters.firstReceivedAt = counters.lastReceivedAt;
      // Große Bodies werden verworfen, ohne sie zu verarbeiten: der Endpunkt ist
      // ohne Token erreichbar und darf kein Speicher-Senkkasten sein.
      const declaredLength = Number(req.headers?.['content-length'] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_CSP_REPORT_BYTES) {
        counters.oversized += 1;
        res.status(204).end();
        return;
      }
      const summaries = summarizeCspReports((req as { body?: unknown }).body);
      if (summaries.length === 0) counters.unusable += 1;
      for (const summary of summaries) {
        counters.violations += 1;
        bump(byDirective, summary.directive);
        bump(byTarget, cspViolationTarget(summary));
        bump(byDocument, summary.documentHost);
        violations.push(summary);
        if (violations.length > MAX_LOGGED_CSP_VIOLATIONS) violations.shift();
        const key = `${summary.directive}|${summary.blockedHost || summary.blockedKeyword}`;
        const last = lastLoggedAt.get(key) ?? 0;
        if (now() - last >= LOG_THROTTLE_MS) {
          lastLoggedAt.set(key, now());
          log(
            `[csp] Verstoss: ${summary.directive} blockiert ${cspViolationTarget(summary) || '(unbekannt)'}`
            + ` auf ${summary.documentHost || '(unbekannt)'}`,
          );
        }
      }
      // Immer 204, immer ohne Inhalt: kein Feedback ueber akzeptierte Formate.
      res.status(204).end();
    },
  );

  // Auswertung des Meldewegs. Der Betreiber entscheidet auf diesen Zahlen, ob
  // `CSP_MODE=enforce` vertretbar ist; die Route ist NICHT tokenfrei (sie liegt
  // unter /api und laeuft durch die normale Studio-Auth).
  app.get(CSP_REPORTS_STATUS_PATH, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok', ...getCspReportStats() });
  });
}
