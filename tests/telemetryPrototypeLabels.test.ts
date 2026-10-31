import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

let appServer: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.VITEST = 'true';
  delete process.env.STUDIO_ACCESS_TOKEN;
  const { app } = await import('../server');
  appServer = app.listen(0);
  baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (appServer) await new Promise<void>((resolve) => appServer.close(() => resolve()));
});

describe('Telemetrie-Zähler mit Prototyp-Namen', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'zählt %s numerisch in JSON und Prometheus',
    async (label) => {
      const events = [
        { type: label, source: label, message: '' },
        { type: label, source: label, message: '' },
        { type: 'xrun', source: label, message: '' },
        { type: 'dropout', source: label, message: '' },
      ];
      const post = await fetch(`${baseUrl}/api/telemetry`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      expect(post.status).toBe(202);
      expect(await post.json()).toEqual({ accepted: 4 });

      const metricsResponse = await fetch(`${baseUrl}/api/metrics`);
      expect(metricsResponse.status).toBe(200);
      const metrics = await metricsResponse.json() as {
        telemetryByType: Record<string, number>;
        telemetryBySource: Record<string, number>;
        telemetryXrunsBySource: Record<string, number>;
      };
      for (const [counts, expected] of [
        [metrics.telemetryByType, 2],
        [metrics.telemetryBySource, 4],
        [metrics.telemetryXrunsBySource, 2],
      ] as const) {
        expect(Object.prototype.hasOwnProperty.call(counts, label)).toBe(true);
        expect(counts[label]).toBe(expected);
      }

      const promResponse = await fetch(`${baseUrl}/api/metrics?format=prometheus`);
      expect(promResponse.status).toBe(200);
      const text = await promResponse.text();
      expect(text).toContain(`audiomonastry_telemetry_events_by_type_total{type="${label}"} 2\n`);
      expect(text).toContain(`audiomonastry_telemetry_events_by_source_total{source="${label}"} 4\n`);
      expect(text).toContain(`audiomonastry_telemetry_xruns_by_source_total{source="${label}"} 2\n`);
    },
  );

  it('behält bestehende Prototyp-Labels nach Erreichen des Kardinalitätsdeckels bei', async () => {
    const send = async (events: Array<{ type: string; source: string; message: string }>) => {
      const response = await fetch(`${baseUrl}/api/telemetry`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: events.length });
    };
    // Establish the labels this test requires, even when run on its own.
    await send([
      { type: 'constructor', source: 'constructor', message: '' },
      { type: 'xrun', source: 'constructor', message: '' },
    ]);
    await send(Array.from({ length: 50 }, (_, i) => ({
      type: `capacity-type-${i}`, source: `capacity-source-${i}`, message: '',
    })));
    await send(Array.from({ length: 50 }, (_, i) => ({
      type: 'xrun', source: `capacity-xrun-${i}`, message: '',
    })));
    const before = await (await fetch(`${baseUrl}/api/metrics`)).json() as {
      telemetryByType: Record<string, number>;
      telemetryBySource: Record<string, number>;
      telemetryXrunsBySource: Record<string, number>;
    };
    await send([
      { type: 'constructor', source: 'constructor', message: '' },
      { type: 'xrun', source: 'constructor', message: '' },
      { type: 'valueOf', source: 'valueOf', message: '' },
      { type: 'xrun', source: 'valueOf', message: '' },
    ]);
    const after = await (await fetch(`${baseUrl}/api/metrics`)).json() as typeof before;
    const count = (counts: Record<string, number>, label: string) => counts[label];
    expect(count(after.telemetryByType, 'constructor')).toBe(count(before.telemetryByType, 'constructor') + 1);
    expect(count(after.telemetryBySource, 'constructor')).toBe(count(before.telemetryBySource, 'constructor') + 2);
    expect(count(after.telemetryXrunsBySource, 'constructor')).toBe(count(before.telemetryXrunsBySource, 'constructor') + 1);
    expect(after.telemetryByType.other).toBe(before.telemetryByType.other + 1);
    expect(after.telemetryBySource.other).toBe(before.telemetryBySource.other + 2);
    expect(after.telemetryXrunsBySource.other).toBe(before.telemetryXrunsBySource.other + 1);
    for (const counts of [after.telemetryByType, after.telemetryBySource, after.telemetryXrunsBySource]) {
      expect(Object.prototype.hasOwnProperty.call(counts, 'valueOf')).toBe(false);
      expect(Object.keys(counts)).toHaveLength(51); // 50 labels plus the 'other' bucket
    }
  });
});
