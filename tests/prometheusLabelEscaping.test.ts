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

describe('Prometheus label escaping', () => {
  it('escaped Zeilenumbrüche, Anführungszeichen und Backslashes in Telemetrie-Labels', async () => {
    const post = await fetch(`${baseUrl}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [
        { type: 'bad\nlabel', source: 'source\nname', message: '' },
        { type: 'xrun', source: 'xrun\nsource', message: '' },
        { type: 'quote"slash\\name', source: 'literal\\n', message: '' },
      ] }),
    });
    expect(post.status).toBe(202);
    const text = await (await fetch(`${baseUrl}/api/metrics?format=prometheus`)).text();
    expect(text).toContain('audiomonastry_telemetry_events_by_type_total{type="bad\\nlabel"} 1');
    expect(text).toContain('audiomonastry_telemetry_events_by_source_total{source="source\\nname"} 1');
    expect(text).toContain('audiomonastry_telemetry_xruns_by_source_total{source="xrun\\nsource"} 1');
    expect(text).toContain('audiomonastry_telemetry_events_by_type_total{type="quote\\"slash\\\\name"} 1');
    expect(text).toContain('audiomonastry_telemetry_events_by_source_total{source="literal\\\\n"} 1');
  });
});
