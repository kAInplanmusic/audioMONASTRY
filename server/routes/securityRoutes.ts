/**
 * audioMONASTRY · Sicherheits-Meldewege (F7-Fix)
 * ==============================================
 *   POST /api/security/csp-report  → Browser-CSP-Verstöße (Content-Security-Policy
 *                                    `report-uri`/`report-to`)
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
 *     die HOSTS von blockiertem Ziel und Dokument (`summarizeCspReport`) – keine
 *     vollen URLs, keine Query-Parameter, keine Cookies.
 *   * **begrenzt**: höchstens `MAX_LOGGED` Einträge im Ringpuffer; geloggt wird
 *     je (Direktive, Host) höchstens einmal pro Minute, damit ein fehlerhaftes
 *     Deployment nicht das Log flutet.
 */
import type { Express } from 'express';
import express from 'express';
import { summarizeCspReport, type CspViolationSummary } from '../csp.ts';

/** Höchstzahl der im Speicher gehaltenen Verstöße (Diagnose, kein Archiv). */
export const MAX_LOGGED_CSP_VIOLATIONS = 20;

/** Maximal akzeptierte Report-Größe (Browser senden wenige hundert Bytes). */
export const MAX_CSP_REPORT_BYTES = 32 * 1024;

/**
 * Body-Parser NUR für diese Route.
 *
 * Der globale `express.json()` in server.ts akzeptiert ausschließlich
 * `application/json`. Browser senden CSP-Reports aber mit
 * `application/csp-report; charset=utf-8` (report-uri) bzw.
 * `application/reports+json` (Reporting-API/report-to) – ohne eigenen Parser kam
 * jeder ECHTE Report als `undefined` an und wurde verworfen; nur die Tests mit
 * `application/json` wären durchgelaufen (vom Test tests/cspPolicy.test.ts
 * aufgedeckt). Die Größe ist schon am Parser begrenzt.
 */
const parseCspReportBody = express.json({
  type: ['application/json', 'application/csp-report', 'application/reports+json'],
  limit: MAX_CSP_REPORT_BYTES,
});

const violations: CspViolationSummary[] = [];
const lastLoggedAt = new Map<string, number>();
const LOG_THROTTLE_MS = 60_000;

/** Bisher beobachtete Verstöße (älteste zuerst) – Diagnose/Test. */
export function getCspViolations(): readonly CspViolationSummary[] {
  return violations;
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

  app.post(
    '/api/security/csp-report',
    (req, res, next) => {
      // Zu große oder unlesbare Bodies werden wie ein unbrauchbarer Report
      // behandelt: der Endpunkt antwortet IMMER 204 und gibt damit auch über
      // Fehlercodes kein Feedback über akzeptierte Formate.
      parseCspReportBody(req, res, (error?: unknown) => {
        if (error) (req as { body?: unknown }).body = undefined;
        next();
      });
    },
    (req, res) => {
      // Große Bodies werden verworfen, ohne sie zu verarbeiten: der Endpunkt ist
      // ohne Token erreichbar und darf kein Speicher-Senkkasten sein.
      const declaredLength = Number(req.headers?.['content-length'] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_CSP_REPORT_BYTES) {
        res.status(204).end();
        return;
      }
      const summary = summarizeCspReport((req as { body?: unknown }).body);
      if (summary) {
        violations.push(summary);
        if (violations.length > MAX_LOGGED_CSP_VIOLATIONS) violations.shift();
        const key = `${summary.directive}|${summary.blockedHost}`;
        const last = lastLoggedAt.get(key) ?? 0;
        if (now() - last >= LOG_THROTTLE_MS) {
          lastLoggedAt.set(key, now());
          log(
            `[csp] Verstoss: ${summary.directive} blockiert ${summary.blockedHost || '(inline)'}`
            + ` auf ${summary.documentHost || '(unbekannt)'}`,
          );
        }
      }
      // Immer 204, immer ohne Inhalt: kein Feedback ueber akzeptierte Formate.
      res.status(204).end();
    },
  );
}
