/**
 * audioMONASTRY · Betriebs-/Telemetrie-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * ================================================================================
 *   GET  /api/health       → Liveness/Readiness (keine Secrets)
 *   GET  /api/metrics      → Prometheus- und JSON-Metriken
 *   GET  /api/online       → Anzahl aktiver Socket-Verbindungen
 *   GET  /api/idle-signal  → Idle-/Shutdown-Signal fuer den Hetzner-Timer (F9)
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
 *
 * --- F8 (online) -----------------------------------------------------------------
 * `getActiveSocketConnections` liefert jetzt die Anzahl der im Socket.io-Registry
 * WIRKLICH verbundenen Sockets (server/socketLiveness.ts). Der fruehere
 * freistehende Zaehler meldete nach abgebrochenen Verbindungen 3 Clients bei 1
 * echten (FIXPLAN F8); ein abgeleiteter Messwert kann strukturell nicht driften.
 *
 * --- F9 (idle-signal) ------------------------------------------------------------
 * Der Timer auf dem Knoten fragte bisher `/api/online` auf Port 80 (Caddy) ab —
 * Klartext-http bekommt dort 308, ohne Token 401; beides endete in der 0 des
 * awk-END-Blocks. Das Signal war deshalb strukturell immer 0. Der neue Endpunkt
 * liefert EINE Entscheidung aus echten Zahlen (aktive Sockets, letzter
 * erfolgreicher App-Request, Host-Fakten des Timers) plus den fertigen Log-Text;
 * die Regeln stehen rein und testbar in server/idleSignal.ts.
 */
import { aiOrchestrator } from '../../src/core/ai/orchestrator/aiOrchestrator';
import { formatLatencyHistogram } from '../../src/core/observability/latencyHistogram';
import {
  createIdleWatcher,
  parseIdleHostFacts,
  resolveIdleThresholdMs,
  summarizeIdleResult,
  type IdleWatcher,
} from '../idleSignal.ts';
import type { SocketLivenessEvaluation } from '../socketLiveness.ts';
import { readBuildInfo } from '../buildInfo';
import { getCloudStatus, getR2Counters } from '../r2Health';
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
  /** AI-P2-006: Drop-Cache-Treffer/Misser (spart Modellaufrufe). */
  aiCacheHits: number;
  aiCacheMisses: number;
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
  /**
   * F9: Zeitpunkt des letzten ERFOLGREICHEN App-Requests (ms epoch) — die dritte
   * Saeule des Idle-Signals neben den Sockets. `null` = seit Prozessstart keiner.
   * Monitoring-Pfade (health/metrics/online/audit) zaehlen bewusst NICHT
   * (IDLE_MONITORING_PATHS in server/idleSignal.ts).
   */
  getLastAppActivityMs?: () => number | null;
  /** F8: Ergebnis des letzten Socket-Sweeps (Geister-Diagnose im Idle-Signal). */
  getSocketLiveness?: () => SocketLivenessEvaluation | null;
}


export function registerOpsRoutes(app: Express, deps: OpsDeps): void {
  const {
    STEM_MAX_JOBS,
    getActiveSocketConnections,
    getStemActiveJobs,
    metrics,
    serverAuditLog,
    getLastAppActivityMs,
    getSocketLiveness,
  } = deps;
  // F9: Der Idle-Watcher lebt mit der Route (eine Instanz je Prozess). Er haelt
  // NUR den Zeitpunkt, seit dem keine Nutzung mehr messbar ist — bewusst kein
  // Zaehlerfile auf dem Knoten (ein Ort weniger, der driften kann).
  const idleWatcher: IdleWatcher = createIdleWatcher();
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
      // FIX F2: Cloud-/R2-Zustand als Metrikquelle (Prozess-Singleton).
      const cloud = getCloudStatus();
      const r2Counters = getR2Counters();
      // Prometheus-Label-Escaping (vor der Nutzung definiert – TDZ).
      const escProm = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
        // AI-P2-006: Drop-Cache - Trefferquote zeigt, wie viele Modellaufrufe
        // (und damit GPU-Wakes) der Cache schon gespart hat.
        '# HELP audiomonastry_ai_drop_cache_hits_total Drop-Generierungen aus dem Cache (kumulativ).',
        '# TYPE audiomonastry_ai_drop_cache_hits_total counter',
        `audiomonastry_ai_drop_cache_hits_total ${metrics.aiCacheHits}`,
        '# HELP audiomonastry_ai_drop_cache_misses_total Drop-Generierungen ohne Cache-Treffer (kumulativ).',
        '# TYPE audiomonastry_ai_drop_cache_misses_total counter',
        `audiomonastry_ai_drop_cache_misses_total ${metrics.aiCacheMisses}`,
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
        // FIX F2: R2-/Cloud-Zustand als Betriebszustand (der Live-Befund war ein
        // Signaturfehler, der nur im Log stand). `ok` ist die einzige Zahl, die
        // eine Alarmregel braucht; die Details stehen im JSON-Zweig.
        '# HELP audiomonastry_cloud_r2_ok R2-Schreibprobe erfolgreich (1) oder nicht (0).',
        '# TYPE audiomonastry_cloud_r2_ok gauge',
        `audiomonastry_cloud_r2_ok ${cloud.r2.ok && cloud.r2.state === 'ok' ? 1 : 0}`,
        '# HELP audiomonastry_cloud_r2_checked_timestamp_seconds Zeitpunkt der letzten R2-Probe (Unix).',
        '# TYPE audiomonastry_cloud_r2_checked_timestamp_seconds gauge',
        `audiomonastry_cloud_r2_checked_timestamp_seconds ${cloud.r2.checkedAt ? Math.round(cloud.r2.checkedAt / 1000) : 0}`,
        '# HELP audiomonastry_cloud_r2_probe_duration_ms Dauer der letzten R2-Schreibprobe in ms.',
        '# TYPE audiomonastry_cloud_r2_probe_duration_ms gauge',
        `audiomonastry_cloud_r2_probe_duration_ms ${cloud.r2.durationMs ?? 0}`,
        '# HELP audiomonastry_cloud_r2_probes_total Anzahl R2-Schreibproben (kumulativ).',
        '# TYPE audiomonastry_cloud_r2_probes_total counter',
        `audiomonastry_cloud_r2_probes_total ${r2Counters.probes}`,
        '# HELP audiomonastry_cloud_r2_probe_failures_total Fehlgeschlagene R2-Schreibproben (kumulativ).',
        '# TYPE audiomonastry_cloud_r2_probe_failures_total counter',
        `audiomonastry_cloud_r2_probe_failures_total ${r2Counters.failures}`,
        '# HELP audiomonastry_cloud_r2_state R2-Zustand als Info-Metrik (Wert 1 = aktiver Zustand).',
        '# TYPE audiomonastry_cloud_r2_state gauge',
        `audiomonastry_cloud_r2_state{state="${escProm(cloud.r2.state)}",problem="${escProm(cloud.r2.problem ?? 'none')}"} 1`,
        '# HELP audiomonastry_cloud_r2_write_failures_total Fehlgeschlagene R2-Schreibvorgaenge je Pfad (kumulativ).',
        '# TYPE audiomonastry_cloud_r2_write_failures_total counter',
        ...(['autosave', 'upload'] as const).map((path) =>
          `audiomonastry_cloud_r2_write_failures_total{path="${path}"} ${cloud.writes[path].failures}`),
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
        cache: { hits: metrics.aiCacheHits, misses: metrics.aiCacheMisses },
        jobs: aiOrchestrator.jobs.list().length,
        costUsd: aiOrchestrator.costs.summary().totalUsd ?? 0,
      },
      stem: { requests: metrics.stemRequests, failures: metrics.stemFailures, active: getStemActiveJobs(), max: STEM_MAX_JOBS },
      // FIX F2: Cloud-Speicher als Betriebszustand. `cloud.r2` nennt Zustand,
      // Ursache, Probeobjekt und Herkunft der Zugangsdaten; `cloud.writes` die
      // letzten Schreibfehler je Pfad (Autosave/Upload). Secret-Werte erscheinen
      // hier nie – nur Variablennamen und Fingerabdrücke.
      cloud: getCloudStatus(),
      telemetryEvents: metrics.telemetryEvents ?? 0,
      telemetryByType: metrics.telemetryByType ?? {},
      telemetryBySource: metrics.telemetryBySource ?? {},
      telemetryXruns: metrics.telemetryXruns ?? 0,
      telemetryXrunsBySource: metrics.telemetryXrunsBySource ?? {},
      lastRequestId: metrics.lastRequestId,
    });
  });

  // --- Aktive User (Socket.io-Verbindungen) für Idle-Auto-Shutdown ------------
  // F8-Fix: `online` ist die Anzahl der im Socket.io-Registry wirklich
  // verbundenen Sockets (abgeleitet, nicht gezaehlt) — Geister aus abgebrochenen
  // Verbindungen koennen den Wert nicht mehr nach oben ziehen. `ghosts`/`idle`
  // sind der letzte Sweep-Stand (Diagnose, additiv; keine Secrets).
  app.get('/api/online', (_req, res) => {
    const liveness = getSocketLiveness?.() ?? null;
    res.json({
      online: Math.max(0, getActiveSocketConnections()),
      ghosts: liveness?.ghosts.length ?? 0,
      idleSockets: liveness?.idle.length ?? 0,
      unattachedSockets: liveness?.unattached.length ?? 0,
    });
  });

  // --- F9: Idle-/Shutdown-Signal fuer den Hetzner-Timer ------------------------
  // Der Timer auf dem Knoten liefert seine Host-Fakten als Query-Parameter
  // (offene TCP-Verbindungen, SSH-Sitzungen, Load, beschaeftigte Container) und
  // optional seine Schwelle (`thresholdSec` aus IDLE_MINUTES); die App liefert
  // ihre eigenen Fakten (aktive Sockets, letzter erfolgreicher App-Request).
  // Die Antwort enthaelt die ENTSCHEIDUNG plus `logLine` — der Timer schreibt
  // damit ECHTE Zahlen und Zeitstempel ins Log statt eines strukturellen `ONLINE=0`.
  // Auth: Scrape-Token (Maschinen-Client, siehe server.ts) oder Studio-Token.
  app.get('/api/idle-signal', (req, res) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const host = parseIdleHostFacts(query);
    const startedAtMs = Number(metrics.startedAt ?? Date.now());
    const lastActivityAtMs = getLastAppActivityMs?.() ?? null;
    const result = idleWatcher.evaluate({
      nowMs: Date.now(),
      onlineSockets: Math.max(0, getActiveSocketConnections()),
      openSockets: host.openSockets,
      sshSessions: host.sshSessions,
      load1: host.load1,
      busyContainers: host.busyContainers,
      lastActivityAtMs,
      startedAtMs,
      idleThresholdMs: resolveIdleThresholdMs(host.thresholdSeconds),
      signalOk: true,
    });
    res.setHeader('Cache-Control', 'no-store');
    // Maschinenlesbar fuer den Timer (dieselben Werte wie im Text/JSON):
    res.setHeader('X-Idle-Verdict', result.evaluation.verdict);
    res.setHeader('X-Idle-Shutdown', result.decision.shutdown ? 'yes' : 'no');
    // `format=text` = genau die Log-Zeile. Der Shell-Timer braucht damit keinen
    // JSON-Parser auf dem Knoten (jq ist dort nicht garantiert) und schreibt
    // trotzdem die Zahlen der App ins Log — eine Quelle, kein Nachbau.
    const wantsText = String(query.format ?? '').toLowerCase() === 'text'
      || String(req.headers.accept ?? '').includes('text/plain');
    if (wantsText) {
      res.type('text/plain; charset=utf-8').send(`${result.logLine}\n`);
      return;
    }
    res.json({
      status: 'ok',
      ...summarizeIdleResult(result, {
        onlineSockets: Math.max(0, getActiveSocketConnections()),
        socketEvaluation: getSocketLiveness?.() ?? null,
      }),
    });
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
