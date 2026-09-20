/**
 * audioMONASTRY · Betriebs-/Telemetrie-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * ================================================================================
 *   GET  /api/health       → Liveness/Readiness (keine Secrets)
 *   GET  /api/metrics      → Prometheus- und JSON-Metriken
 *   GET  /api/online       → Anzahl aktiver Socket-Verbindungen
 *   GET  /api/audit        → Audit-Log (Rollenwechsel, Lock-Events, RBAC-Denials)
 *   POST /api/telemetry    → Client-Telemetrie (Xruns, Latenz, Events)
 *   POST /api/alerts       → Alert-Webhook (strukturierte Warnungen)
 * 
 * Zwei Zaehler bleiben in server.ts, weil Socket- bzw. Stem-Lebenszyklus sie dort
 * schreiben; sie werden als Getter gereicht (nicht als Wertkopie, sonst wuerde die
 * Anzeige einfrieren): getActiveSocketConnections, getStemActiveJobs. metrics und
 * serverAuditLog sind Objekt/Array und werden als Referenz geteilt.
 * 
 * Der Code wurde 1:1 verschoben; die Einrueckung ist die einzige Aenderung.
 */
import { aiOrchestrator } from '../../src/core/ai/orchestrator/aiOrchestrator';
import { formatLatencyHistogram } from '../../src/core/observability/latencyHistogram';
import { readBuildInfo } from '../buildInfo';
import { AlertsWebhookSchema, TelemetryPayloadSchema } from '../../src/types/zod/schemas';
import express from 'express';
import type { Express } from 'express';

/** Zaehler, die server.ts besitzt; hier werden sie gelesen und fortgeschrieben. */
export interface OpsMetrics {
  requests: number;
  errors: number;
  latencyMsSum: number;
  /** PROD-P1-004: Histogramm fuer das Latenz-SLO (p95). */
  latencyHistogram?: { snapshot: () => { buckets: number[]; count: number; sumSeconds: number } };
  aiRequests: number;
  aiFailures: number;
  stemRequests: number;
  stemFailures: number;
  telemetryEvents: number;
  startedAt: number;
  lastRequestId: string;
  telemetryByType: Record<string, number>;
  telemetryBySource: Record<string, number>;
  telemetryXruns: number;
  telemetryXrunsBySource: Record<string, number>;
}

/** Ein Eintrag des serverseitigen Audit-Logs (P4-2). */
export interface AuditLogEntry {
  ts: string;
  userId: string;
  role: string;
  action: string;
  target?: string;
  ok: boolean;
}
/** Von server.ts gereichte Abhaengigkeiten (siehe Modul-Kommentar). */
export interface OpsDeps {
  STEM_MAX_JOBS: number;
  getActiveSocketConnections: () => number;
  getStemActiveJobs: () => number;
  metrics: OpsMetrics;
  serverAuditLog: AuditLogEntry[];
}


export function registerOpsRoutes(app: Express, deps: OpsDeps): void {
  const { STEM_MAX_JOBS, getActiveSocketConnections, getStemActiveJobs, metrics, serverAuditLog } = deps;
  // --- Health check ---
  // PROD-P0-003: zusaetzlich die Build-Version (kein Secret, additiv). Damit ist
  // nach einem Deploy/Rollback von aussen pruefbar, WELCHE Version laeuft.
  // PROD-P1-F4: zusaetzlich Commit (kurzer SHA) und Build-Zeit. Die Version
  // allein aendert sich nicht mit jedem Commit - erst der Commit macht die
  // Commit-Paritaet zwischen Flotte und Repo belegbar (Staleness-Gate im
  // Portal-Worker und in scripts/hetzner/fleet-preflight.sh). Die Felder bleiben
  // additiv und secretfrei; ohne Build-Arg steht dort `dev`/`unknown`.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', ...readBuildInfo() });
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
        '# HELP audiomonastry_uptime_seconds Prozess-Uptime in Sekunden.',
        '# TYPE audiomonastry_uptime_seconds gauge',
        `audiomonastry_uptime_seconds ${uptime}`,
        '# HELP audiomonastry_http_requests_total Anzahl HTTP-Requests (kumulativ).',
        '# TYPE audiomonastry_http_requests_total counter',
        `audiomonastry_http_requests_total ${metrics.requests}`,
        '# HELP audiomonastry_http_errors_total Anzahl HTTP-Fehler >= 400 (kumulativ).',
        '# TYPE audiomonastry_http_errors_total counter',
        `audiomonastry_http_errors_total ${metrics.errors}`,
        '# HELP audiomonastry_http_avg_latency_ms Durchschnittliche Request-Latenz in ms.',
        '# TYPE audiomonastry_http_avg_latency_ms gauge',
        `audiomonastry_http_avg_latency_ms ${avgLatencyMs}`,
        // PROD-P1-004: p95/p99 brauchen ein Histogramm (Latenz-SLO).
        ...(metrics.latencyHistogram ? formatLatencyHistogram(metrics.latencyHistogram.snapshot()) : []),
        '# HELP audiomonastry_ai_requests_total Anzahl KI-Proxy-Requests (kumulativ).',
        '# TYPE audiomonastry_ai_requests_total counter',
        `audiomonastry_ai_requests_total ${metrics.aiRequests}`,
        '# HELP audiomonastry_ai_failures_total Anzahl KI-Proxy-Fehler (kumulativ).',
        '# TYPE audiomonastry_ai_failures_total counter',
        `audiomonastry_ai_failures_total ${metrics.aiFailures}`,
        '# HELP audiomonastry_stem_requests_total Anzahl Stem-Separation-Requests (kumulativ).',
        '# TYPE audiomonastry_stem_requests_total counter',
        `audiomonastry_stem_requests_total ${metrics.stemRequests}`,
        '# HELP audiomonastry_stem_failures_total Anzahl Stem-Separation-Fehler (kumulativ).',
        '# TYPE audiomonastry_stem_failures_total counter',
        `audiomonastry_stem_failures_total ${metrics.stemFailures}`,
        '# HELP audiomonastry_stem_jobs_active Aktive Stem-Jobs.',
        '# TYPE audiomonastry_stem_jobs_active gauge',
        `audiomonastry_stem_jobs_active ${getStemActiveJobs()}`,
        '# HELP audiomonastry_stem_jobs_max Maximale parallele Stem-Jobs.',
        '# TYPE audiomonastry_stem_jobs_max gauge',
        `audiomonastry_stem_jobs_max ${STEM_MAX_JOBS}`,
        '# HELP audiomonastry_telemetry_events_total Client-Telemetrie-Events (kumulativ).',
        '# TYPE audiomonastry_telemetry_events_total counter',
        `audiomonastry_telemetry_events_total ${metrics.telemetryEvents ?? 0}`,
        '# HELP audiomonastry_telemetry_xruns_total Xrun-/Dropout-Telemetrie-Events (kumulativ).',
        '# TYPE audiomonastry_telemetry_xruns_total counter',
        `audiomonastry_telemetry_xruns_total ${metrics.telemetryXruns ?? 0}`,
        '# HELP audiomonastry_ai_jobs_total Anzahl AI-Orchestrator-Jobs (kumulativ).',
        '# TYPE audiomonastry_ai_jobs_total counter',
        `audiomonastry_ai_jobs_total ${aiOrchestrator.jobs.list().length}`,
        '# HELP audiomonastry_ai_cost_usd Geschätzte AI-Kosten (USD, kumulativ).',
        '# TYPE audiomonastry_ai_cost_usd gauge',
        `audiomonastry_ai_cost_usd ${aiOrchestrator.costs.summary().totalUsd ?? 0}`,
      ];
      // P2 Live-Telemetrie-Dashboard: Breakdown nach type/source für Grafana-Panels.
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      for (const [type, count] of Object.entries(metrics.telemetryByType ?? {})) {
        lines.push(
          '# HELP audiomonastry_telemetry_events_by_type_total Client-Telemetrie-Events nach Typ.',
          '# TYPE audiomonastry_telemetry_events_by_type_total counter',
          `audiomonastry_telemetry_events_by_type_total{type="${esc(type)}"} ${count}`,
        );
      }
      for (const [source, count] of Object.entries(metrics.telemetryBySource ?? {})) {
        lines.push(
          '# HELP audiomonastry_telemetry_events_by_source_total Client-Telemetrie-Events nach Quelle.',
          '# TYPE audiomonastry_telemetry_events_by_source_total counter',
          `audiomonastry_telemetry_events_by_source_total{source="${esc(source)}"} ${count}`,
        );
      }
      for (const [source, count] of Object.entries(metrics.telemetryXrunsBySource ?? {})) {
        lines.push(
          '# HELP audiomonastry_telemetry_xruns_by_source_total Xrun-/Dropout-Events nach Quelle.',
          '# TYPE audiomonastry_telemetry_xruns_by_source_total counter',
          `audiomonastry_telemetry_xruns_by_source_total{source="${esc(source)}"} ${count}`,
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
      stem: { requests: metrics.stemRequests, failures: metrics.stemFailures, active: getStemActiveJobs(), max: STEM_MAX_JOBS },
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
    res.json({ online: Math.max(0, getActiveSocketConnections()) });
  });

  // --- P4-2: Server-Audit-Log (Rollenzuweisung, Plugin-State, RBAC-Denials) ----
  app.get('/api/audit', (_req, res) => {
    res.json({ entries: serverAuditLog.slice(-500).reverse(), total: serverAuditLog.length });
  });

  // --- Live-Telemetrie: Client-Events/Fehler einsammeln (auto-logging) --------
  // POST /api/telemetry  body: { events: [{type, source, message, context?, ts?}] }
  // Der Server loggt jede Meldung als JSON-Line (Docker-Log-Rotation greift)
  // und zählt sie in den Prometheus-Metriken (audiomonastry_telemetry_events_total).
  app.post('/api/telemetry', express.json({ limit: '1mb' }), (req, res) => {
    // ARCH-SEC-003: Runtime-Validierung statt `as any`-Cast auf externe Nutzdaten.
    const parsed = TelemetryPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid telemetry payload', details: parsed.error.issues.slice(0, 5) });
    }
    const events = parsed.data.events;
    let accepted = 0;
    for (const ev of events) {
      const type = ev.type;
      const source = ev.source;
      const message = ev.message;
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
    const parsedAlerts = AlertsWebhookSchema.safeParse(req.body ?? {});
    if (!parsedAlerts.success) {
      return res.status(400).json({ error: parsedAlerts.error.issues[0]?.message ?? 'invalid payload' });
    }
    const alerts = parsedAlerts.data.alerts ?? [];
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
      const inst = labels.instance ?? labels.alertname ?? 'audioMONASTRY';
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

}
