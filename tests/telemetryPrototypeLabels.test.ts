process.env.NODE_ENV ??= 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * UI-2026-11-06-003 (a): Telemetrie-Labels müssen prototype-sicher sein.
 *
 * Vorher: `telemetryByType`/`telemetryBySource` waren Plain Objects. Ein Client,
 * der `type: "constructor"` schickt, traf beim Lesen eine geerbte Funktion
 * (`Object.keys` enthält den Schlüssel nicht, `map[type]` liefert aber
 * `Object`), im Zähler entstand `[native code]1`, und `__proto__` verschwand
 * ganz. Der Prometheus-Export schrieb diesen Nicht-Zahlen-Wert als Sample-Wert
 * (`...{type="constructor"} function Object() { [native code] }1`) — ungültiges
 * Textformat, jeder Scrape dieser Instanz bricht ab.
 *
 * Geprüft wird deshalb nicht der Zählerstand allein, sondern:
 *  1. gefährliche Labels landen als `other` (kein Prototype-Treffer, kein
 *     Verschwinden von `__proto__`),
 *  2. alle Zähler sind endliche Zahlen,
 *  3. die komplette /api/metrics-Prometheus-Antwort ist Textformat 0.0.4
 *     (jede Sample-Zeile: Name, optionale Labels, endlicher Wert).
 */

/** Prometheus-Textformat 0.0.4: eine Sample-Zeile. */
const PROM_SAMPLE_LINE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{(?:[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\.)*",?)*\})? -?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|NaN|[+-]Inf)$/;

function invalidPromLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .filter((line) => !PROM_SAMPLE_LINE.test(line));
}

describe('UI-2026-11-06-003: /api/telemetry – gefährliche Labels werden zu "other"', () => {
  let appServer: Server;
  let baseUrl = '';

  const post = (events: unknown[]) => fetch(`${baseUrl}/api/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });

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

  it('zählt __proto__/constructor/toString als "other" und lässt Object.prototype unberührt', async () => {
    const res = await post([
      { type: '__proto__', source: 'ui-003-source-a', message: 'proto', ts: Date.now() },
      { type: 'constructor', source: 'constructor', message: 'ctor', ts: Date.now() },
      { type: 'toString', source: 'ui-003-source-a', message: 'tos', ts: Date.now() },
      { type: 'ui-003-safe', source: 'ui-003-source-a', message: 'ok', ts: Date.now() },
    ]);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: 4 });

    // Kein Prototype-Lookup darf als Global-Mutation durchschlagen.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'ui-003-safe')).toBe(false);

    const metrics = await (await fetch(`${baseUrl}/api/metrics`)).json() as {
      telemetryByType?: Record<string, number>;
      telemetryBySource?: Record<string, number>;
      telemetryEvents?: number;
    };
    const byType = metrics.telemetryByType ?? {};
    const bySource = metrics.telemetryBySource ?? {};

    // Alle drei gefährlichen Labels sind zu EINEM sicheren Label zusammengefasst.
    expect(byType.other).toBe(3);
    expect(byType['ui-003-safe']).toBe(1);
    // Achtung: `byType.__proto__` liefert auf einem JSON-Objekt Object.prototype –
    // ein `undefined`-Vergleich wäre also falsch grün. Der Eigentums-Test ist hart.
    for (const bad of ['__proto__', 'constructor', 'toString']) {
      expect(Object.prototype.hasOwnProperty.call(byType, bad), `Label ${bad}`).toBe(false);
    }
    expect(Object.keys(byType).sort()).toEqual(['other', 'ui-003-safe']);
    expect(Object.prototype.hasOwnProperty.call(bySource, 'constructor')).toBe(false);
    expect(bySource.other).toBe(1);

    // Zähler sind endliche Zahlen (kein "[native code]1", kein String).
    for (const [label, count] of Object.entries(byType)) {
      expect(Number.isFinite(count), `byType[${label}] = ${String(count)}`).toBe(true);
      expect(count).toBeGreaterThan(0);
    }
    for (const [label, count] of Object.entries(bySource)) {
      expect(Number.isFinite(count), `bySource[${label}] = ${String(count)}`).toBe(true);
    }
    expect(Number.isFinite(metrics.telemetryEvents)).toBe(true);
  });

  it('liefert weiterhin ein gültiges Prometheus-Textformat (Scrape bleibt intakt)', async () => {
    const text = await (await fetch(`${baseUrl}/api/metrics?format=prometheus`)).text();

    // Der eigentliche Regressionsbefund: keine Nicht-Zahl als Sample-Wert.
    expect(invalidPromLines(text)).toEqual([]);
    expect(text).not.toContain('[native code]');
    expect(text).not.toContain('type="constructor"');
    expect(text).not.toContain('type="__proto__"');

    // Die gefährlichen Events stehen als sicheres Label im Export.
    expect(text).toContain('audiomonastry_telemetry_events_by_type_total{type="other"} 3');
    expect(text).toContain('audiomonastry_telemetry_events_by_type_total{type="ui-003-safe"} 1');

    // HELP/TYPE je Serie genau einmal (Parser-Vertrag).
    for (const series of ['audiomonastry_telemetry_events_by_type_total', 'audiomonastry_telemetry_events_by_source_total']) {
      expect(text.split('\n').filter((l) => l === `# HELP ${series}`).length).toBeLessThanOrEqual(1);
      expect(text.split('\n').filter((l) => l.startsWith(`# TYPE ${series} `)).length).toBeLessThanOrEqual(1);
    }
  });

  it('überschreibt keinen Zähler mit einem Nicht-Zahlen-Wert (Wiederholung bleibt monoton)', async () => {
    const before = await (await fetch(`${baseUrl}/api/metrics`)).json() as { telemetryByType?: Record<string, number> };
    const beforeOther = before.telemetryByType?.other ?? 0;
    await post([{ type: 'valueOf', source: 'hasOwnProperty', message: 'again', ts: Date.now() }]);
    const after = await (await fetch(`${baseUrl}/api/metrics`)).json() as { telemetryByType?: Record<string, number> };
    expect(after.telemetryByType?.other).toBe(beforeOther + 1);
  });

  it('kappt Zeilenumbrüche im Label (sonst zerfällt die Export-Zeile)', async () => {
    const res = await post([{ type: 'zeile\numbruch', source: 'ui-003-source-a', message: 'nl', ts: Date.now() }]);
    expect(res.status).toBe(202);
    const text = await (await fetch(`${baseUrl}/api/metrics?format=prometheus`)).text();
    expect(invalidPromLines(text)).toEqual([]);
    // Kein roher Umbruch aus dem Label, und der Typ ist kein eigener Serienname.
    expect(text).not.toContain('zeile\numbruch');
    expect(text).toContain('audiomonastry_telemetry_events_by_type_total{type="other"}');
  });

  it('hält normale Labels inkl. Umlauten unverändert (keine Über-Säuberung)', async () => {
    await post([{ type: 'größe', source: 'ui-003-quelle-ü', message: 'utf8', ts: Date.now() }]);
    const metrics = await (await fetch(`${baseUrl}/api/metrics`)).json() as {
      telemetryByType?: Record<string, number>; telemetryBySource?: Record<string, number>;
    };
    expect(metrics.telemetryByType?.['größe']).toBe(1);
    expect(metrics.telemetryBySource?.['ui-003-quelle-ü']).toBe(1);
    const text = await (await fetch(`${baseUrl}/api/metrics?format=prometheus`)).text();
    expect(text).toContain('audiomonastry_telemetry_events_by_type_total{type="größe"} 1');
    expect(invalidPromLines(text)).toEqual([]);
  });
});
