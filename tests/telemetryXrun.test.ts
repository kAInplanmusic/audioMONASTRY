import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Telemetry } from '../src/utils/telemetry';

describe('AM-E6-1: Telemetry – Xrun-Histogramm, Worklet-CPU-Budgets, Allokationen', () => {
  it('recordXrun führt Histogramm (max. 100) und Zähler', () => {
    const t = new Telemetry();
    t.recordXrun('audio-engine');
    t.recordXrun('analyzer-processor');
    const snap = t.snapshot();
    expect(snap.xruns.count).toBe(2);
    expect(snap.xruns.history.map((x) => x.source)).toEqual(['audio-engine', 'analyzer-processor']);

    for (let i = 0; i < 150; i++) t.recordXrun('burst');
    expect(t.snapshot().xruns.history).toHaveLength(100);
    expect(t.snapshot().xruns.count).toBe(152);
  });

  it('recordWorkletCpu führt Budgets und zählt Verletzungen', () => {
    const t = new Telemetry();
    const violations: string[] = [];
    t.onBudgetViolation((w, ms, budget) => violations.push(`${w}:${ms}>${budget}`));

    t.recordWorkletCpu('mastering-processor', 1.2);
    expect(t.snapshot().worklets.find((w) => w.worklet === 'mastering-processor')?.violations).toBe(0);

    t.recordWorkletCpu('mastering-processor', 3.5, 2);
    expect(t.snapshot().worklets.find((w) => w.worklet === 'mastering-processor')?.violations).toBe(1);
    expect(violations).toEqual(['mastering-processor:3.5>2']);
  });

  it('recordWorkletAllocation zählt je Worklet und gesamt', () => {
    const t = new Telemetry();
    t.recordWorkletAllocation('eq-processor');
    t.recordWorkletAllocation('eq-processor');
    t.recordWorkletAllocation('dsp-processor');
    const snap = t.snapshot();
    expect(snap.counters['worklet.allocations']).toBe(3);
    expect(snap.counters['worklet.allocations.eq-processor']).toBe(2);
    expect(snap.counters['worklet.allocations.dsp-processor']).toBe(1);
  });

  it('snapshot liefert Kopien (keine Referenz-Mutation)', () => {
    const t = new Telemetry();
    t.recordXrun('a');
    const snap = t.snapshot();
    snap.xruns.history.pop();
    snap.worklets.push({ worklet: 'fake', budgetMs: 1, lastMs: 0, violations: 0 });
    expect(t.snapshot().xruns.history).toHaveLength(1);
    expect(t.snapshot().worklets).toHaveLength(0);
  });
});

describe('AM-E6-1: /api/telemetry aggregiert Xrun-/Dropout-Events', () => {
  let appServer: Server;
  let baseUrl = '';

  beforeAll(async () => {
    process.env.VITEST = 'true';
    delete process.env.STUDIO_ACCESS_TOKEN;
    const mod = await import('../server');
    appServer = mod.app.listen(0);
    const addr = appServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
  });

  it('zählt xrun/dropout-Events nach Quelle und exponiert sie in /api/metrics', async () => {
    const post = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          { type: 'xrun', source: 'audio-engine', message: 'Xrun', ts: Date.now() },
          { type: 'dropout', source: 'audio-thread', message: 'Dropout', ts: Date.now() },
          { type: 'latency', source: 'telemetry', message: 'Latenz', ts: Date.now() },
        ],
      }),
    });
    expect(post.status).toBe(202);

    const res = await fetch(`${baseUrl}/api/metrics`);
    const metrics = await res.json() as { telemetryXruns?: number; telemetryXrunsBySource?: Record<string, number> };
    expect(metrics.telemetryXruns).toBe(2);
    expect(metrics.telemetryXrunsBySource?.['audio-engine']).toBe(1);
    expect(metrics.telemetryXrunsBySource?.['audio-thread']).toBe(1);

    const prom = await fetch(`${baseUrl}/api/metrics?format=prometheus`);
    const text = await prom.text();
    expect(text).toContain('samplemonk_telemetry_xruns_total 2');
    expect(text).toContain('samplemonk_telemetry_xruns_by_source_total{source="audio-engine"} 1');
  });
});
