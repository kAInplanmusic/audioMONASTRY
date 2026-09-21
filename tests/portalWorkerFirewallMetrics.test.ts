/**
 * Portal-Worker: die app-Firewall muss den Metrik-Port mitschreiben.
 *
 * Anlass (live gemessen 2026-09-21): der Prometheus-Job `audiomonastry` scrapt den
 * App-Container DIREKT (`http://<app-ip>:8080/api/metrics`), weil der Weg ueber die
 * Produktions-Domain bei gestoerter Cloudflare-Kette blind ist (HTTP 521). Die
 * Regel setzt `scripts/hetzner/firewall-ensure-app-metrics.py`.
 *
 * Der Portal-Worker setzt beim Wake/`/api/wire-fleet` die app-Firewall komplett neu
 * (`set_rules`) - ohne die 8080-Regel in SEINER Liste haette der naechste Lauf sie
 * still entfernt und der App-Job waere `down` (niemand haette es bemerkt, weil der
 * Scrape-Fehler nur im Prometheus-Ziel sichtbar ist).
 *
 * Der Test haelt beide Quellen zusammen: die Zahl im Worker und die Zahl/Quelle im
 * Python-Werkzeug muessen identisch sein.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { envFile, firewallRules } from '../services/portal-worker/src/index.js';

const REPO = path.resolve(__dirname, '..');
const METRICS_SCRIPT = path.join(REPO, 'scripts', 'hetzner', 'firewall-ensure-app-metrics.py');

function ruleFor(rules: Array<Record<string, unknown>>, port: string) {
  return rules.find((rule) => String(rule.port ?? '') === port);
}

describe('Portal-Worker · app-Firewall und Metrik-Port', () => {
  it('oeffnet 8080 nur fuer den Monitoring-Knoten, wenn dessen IP bekannt ist', () => {
    const rules = firewallRules('app', ['203.0.113.0/24'], { metricsSourceIp: '198.51.100.7' });
    const metrics = ruleFor(rules as Array<Record<string, unknown>>, '8080');
    expect(metrics, 'Regel fuer Port 8080 fehlt').toBeDefined();
    expect(metrics?.direction).toBe('in');
    expect(metrics?.protocol).toBe('tcp');
    expect(metrics?.source_ips).toEqual(['198.51.100.7/32']);
  });

  it('setzt ohne bekannte Monitoring-IP keine offene 8080-Regel', () => {
    const rules = firewallRules('app', ['203.0.113.0/24']) as Array<Record<string, unknown>>;
    expect(ruleFor(rules, '8080')).toBeUndefined();
    // Und erst recht nicht fuer das ganze Internet (Sicherheitszusage).
    for (const rule of rules) {
      if (String(rule.port ?? '') === '8080') {
        expect(rule.source_ips).not.toContain('0.0.0.0/0');
      }
    }
  });

  it('haelt Port und Quelle mit scripts/hetzner/firewall-ensure-app-metrics.py deckungsgleich', () => {
    const script = readFileSync(METRICS_SCRIPT, 'utf8');
    const portMatch = /METRICS_PORT = "(\d+)"/.exec(script);
    const ipMatch = /EDGE_IP = "([\d.]+)"/.exec(script);
    expect(portMatch, 'METRICS_PORT im Python-Werkzeug nicht gefunden').not.toBeNull();
    expect(ipMatch, 'EDGE_IP im Python-Werkzeug nicht gefunden').not.toBeNull();

    const port = portMatch?.[1] as string;
    const edgeIp = ipMatch?.[1] as string;
    const rules = firewallRules('app', ['203.0.113.0/24'], { metricsSourceIp: edgeIp }) as Array<Record<string, unknown>>;
    const metrics = ruleFor(rules, port);
    expect(metrics, `Worker-Regel fuer Port ${port} fehlt`).toBeDefined();
    expect(metrics?.source_ips).toEqual([`${edgeIp}/32`]);
  });

  it('laesst die Cloudflare-Begrenzung fuer 80/443 unberuehrt', () => {
    const cf = ['203.0.113.0/24'];
    const rules = firewallRules('app', cf, { metricsSourceIp: '198.51.100.7' }) as Array<Record<string, unknown>>;
    expect(ruleFor(rules, '80')?.source_ips).toEqual(cf);
    expect(ruleFor(rules, '443')?.source_ips).toEqual(cf);
  });
});

describe('Portal-Worker · Knoten-.env je Rolle (Caddy-Site)', () => {
  it('setzt die SFU-Site aus der Signalisierungs-URL (sonst kein TLS auf sfu-1)', () => {
    const lines = envFile({ SFU_SIGNALING_URL: 'https://sfu.anunnakitools.de' }, 'sfu').split('\n');
    expect(lines).toContain('DOMAIN=sfu.anunnakitools.de');
  });

  it('laesst die SFU-Site leer, wenn die Signalisierungs-URL fehlt (dokumentierte Luecke)', () => {
    const lines = envFile({}, 'sfu').split('\n');
    expect(lines).toContain('DOMAIN=');
  });

  it('setzt fuer app weiter die Produktions-Domain', () => {
    const lines = envFile({ APP_DOMAIN: 'anunnakitools.de' }, 'app').split('\n');
    expect(lines).toContain('DOMAIN=anunnakitools.de');
  });

  it('schreibt leere Werte NICHT in die Knoten-.env (kein Ueberschreiben mit Leerstring)', () => {
    const lines = envFile({}, 'app').split('\n');
    expect(lines.some((line) => line.startsWith('SFU_SIGNALING_URL='))).toBe(false);
    expect(lines.some((line) => line.startsWith('TURN_URLS='))).toBe(false);
    expect(lines.some((line) => line.startsWith('TURN_STATIC_AUTH_SECRET='))).toBe(false);
  });
});
