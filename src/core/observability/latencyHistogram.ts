/**
 * audioMONASTRY · Latenz-Histogramm fuer das SLO (PROD-P1-004)
 * =====================================================================
 * Bis hierher exportierte der Server nur die MITTLERE Request-Latenz als Gauge
 * (`audiomonastry_http_avg_latency_ms`). Ein Mittelwert verdeckt genau das, was ein
 * Latenz-SLO messen soll: den langen Schwanz. Deshalb zaehlt dieses Modul die
 * Requests in feste Zeit-Buckets (Prometheus-Histogramm) - damit kann
 * Prometheus mit `histogram_quantile(0.95, ...)` ein echtes p95 rechnen.
 *
 * Rein und damit ohne Server testbar: `observe()`, die kumulative Auszaehlung
 * und die Text-Exposition.
 */

/** Obergrenzen in Sekunden (Prometheus-Konvention: Sekunden, nicht Millisekunden). */
export const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

export interface LatencyHistogramSnapshot {
  /** Kumulativ: Index i = Anzahl Requests <= LATENCY_BUCKETS_SECONDS[i]. */
  buckets: number[];
  /** Gesamtzahl beobachteter Requests. */
  count: number;
  /** Summe aller beobachteten Dauern in Sekunden. */
  sumSeconds: number;
}

export class LatencyHistogram {
  private readonly counts: number[];
  private count = 0;
  private sumSeconds = 0;

  constructor(private readonly bounds: readonly number[] = LATENCY_BUCKETS_SECONDS) {
    this.counts = bounds.map(() => 0);
  }

  /** Eine Dauer (Millisekunden) einsortieren. Negative/ungueltige Werte werden verworfen. */
  observe(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const seconds = durationMs / 1000;
    this.count += 1;
    this.sumSeconds += seconds;
    for (let i = 0; i < this.bounds.length; i += 1) {
      if (seconds <= this.bounds[i]) this.counts[i] += 1;
    }
  }

  snapshot(): LatencyHistogramSnapshot {
    return { buckets: [...this.counts], count: this.count, sumSeconds: this.sumSeconds };
  }

  reset(): void {
    this.counts.fill(0);
    this.count = 0;
    this.sumSeconds = 0;
  }
}

/**
 * Prometheus-Text-Exposition (Format 0.0.4). `+Inf` = Gesamtzahl, `_sum`/`_count`
 * gehoeren zum Histogramm und sind Pflicht fuer `histogram_quantile`.
 */
export function formatLatencyHistogram(
  snapshot: LatencyHistogramSnapshot,
  metric = 'audiomonastry_http_request_duration_seconds',
  bounds: readonly number[] = LATENCY_BUCKETS_SECONDS,
): string[] {
  const lines = [
    `# HELP ${metric} HTTP-Request-Dauer in Sekunden (Histogramm fuer p95/p99).`,
    `# TYPE ${metric} histogram`,
  ];
  const buckets = snapshot.buckets.length === bounds.length
    ? snapshot.buckets
    : bounds.map((_, i) => snapshot.buckets[i] ?? 0);
  for (let i = 0; i < bounds.length; i += 1) {
    lines.push(`${metric}_bucket{le="${bounds[i]}"} ${buckets[i]}`);
  }
  lines.push(`${metric}_bucket{le="+Inf"} ${snapshot.count}`);
  lines.push(`${metric}_sum ${snapshot.sumSeconds}`);
  lines.push(`${metric}_count ${snapshot.count}`);
  return lines;
}
