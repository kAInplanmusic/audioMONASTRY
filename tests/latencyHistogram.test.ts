import { describe, expect, it } from 'vitest';
import {
  LATENCY_BUCKETS_SECONDS,
  LatencyHistogram,
  formatLatencyHistogram,
} from '../src/core/observability/latencyHistogram';

/**
 * PROD-P1-004: Das Latenz-SLO (p95) braucht ein Histogramm - der Mittelwert
 * allein verdeckt den langen Schwanz. Geprueft wird die kumulative Zaehlung und
 * die Prometheus-Text-Exposition (daraus rechnet Prometheus histogram_quantile).
 */
describe('LatencyHistogram', () => {
  it('zaehlt kumulativ und summiert in Sekunden', () => {
    const h = new LatencyHistogram();
    h.observe(3);     // 0.003 s  <= 5ms
    h.observe(20);    // 0.02 s   <= 25ms
    h.observe(300);   // 0.3 s    <= 500ms
    const snap = h.snapshot();
    expect(snap.count).toBe(3);
    expect(snap.sumSeconds).toBeCloseTo(0.323, 6);
    // 0.003 liegt in den Buckets <=5ms/<=10ms; 0.02 zusaetzlich in <=25ms/<=50ms.
    expect(snap.buckets.slice(0, 4)).toEqual([1, 1, 2, 2]);
    // 0.3 s erst ab dem 500-ms-Bucket
    expect(snap.buckets[LATENCY_BUCKETS_SECONDS.indexOf(0.25)]).toBe(2);
    expect(snap.buckets[LATENCY_BUCKETS_SECONDS.indexOf(0.5)]).toBe(3);
  });

  it('verwirft ungueltige Dauern (kein NaN im Export)', () => {
    const h = new LatencyHistogram();
    h.observe(Number.NaN);
    h.observe(-5);
    h.observe(Number.POSITIVE_INFINITY);
    expect(h.snapshot()).toEqual({ buckets: LATENCY_BUCKETS_SECONDS.map(() => 0), count: 0, sumSeconds: 0 });
  });

  it('exportiert das Prometheus-Textformat mit +Inf, _sum und _count', () => {
    const h = new LatencyHistogram();
    h.observe(12);
    h.observe(2000);
    const lines = formatLatencyHistogram(h.snapshot());
    expect(lines[0]).toContain('# HELP audiomonastry_http_request_duration_seconds');
    expect(lines[1]).toBe('# TYPE audiomonastry_http_request_duration_seconds histogram');
    // 12 ms liegt ueber 10 ms und unter 25 ms -> le="0.01" ist noch 0, le="0.025" zaehlt.
    expect(lines).toContain('audiomonastry_http_request_duration_seconds_bucket{le="0.01"} 0');
    expect(lines).toContain('audiomonastry_http_request_duration_seconds_bucket{le="0.025"} 1');
    expect(lines).toContain('audiomonastry_http_request_duration_seconds_bucket{le="+Inf"} 2');
    expect(lines).toContain('audiomonastry_http_request_duration_seconds_count 2');
    expect(lines.some((l) => l.startsWith('audiomonastry_http_request_duration_seconds_sum 2.012'))).toBe(true);
    // Genau ein +Inf-Bucket und EINE Zeile pro Obergrenze (Prometheus-Pflicht).
    expect(lines.filter((l) => l.includes('_bucket{')).length).toBe(LATENCY_BUCKETS_SECONDS.length + 1);
  });

  it('reset() leert Zaehler und Summe', () => {
    const h = new LatencyHistogram();
    h.observe(100);
    h.reset();
    expect(h.snapshot().count).toBe(0);
    expect(h.snapshot().sumSeconds).toBe(0);
  });
});
