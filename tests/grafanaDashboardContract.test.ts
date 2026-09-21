// Grafana-Dashboard-Vertrag fuer scripts/hetzner/grafana-dashboards/audiomonastry-overview.json.
//
// Anlass (Befund 2026-09-22): Die Panels 19-22 trugen jedes ZEICHEN ihres
// Ausdrucks als EIGENES Target (Muster `for ch in expr: targets.append({'expr': ch})`):
// Panel 19 hatte 36, Panel 20 70, Panel 21 52 und Panel 22 108 Ein-Zeichen-Targets.
// Grafana rendert solche Fragmente nicht - die Panels waren leer, obwohl das
// Dashboard syntaktisch gueltiges JSON war. Ein blosser JSON-Parse-Test haette
// den Defekt NICHT gefunden, deshalb prueft dieser Vertrag je Target eine
// plausible PromQL-Form und die Herkunft der Metriknamen.
//
// Die Herkunftspruefung bindet das Dashboard an die EINE Quelle der
// veroeffentlichten Metriken: server/routes/opsRoutes.ts (/api/metrics?
// format=prometheus, gescraped von scripts/hetzner/prometheus.yml) und
// src/core/observability/latencyHistogram.ts. Ein Tippfehler oder ein
// erfundener Metrikname faellt damit sofort.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DASHBOARD_PATH = 'scripts/hetzner/grafana-dashboards/audiomonastry-overview.json';

interface DashboardTarget {
  refId?: string;
  expr?: string;
  legendFormat?: string;
  datasource?: { type?: string; uid?: string };
}

interface DashboardPanel {
  id: number;
  title: string;
  datasource?: { type?: string; uid?: string };
  targets?: DashboardTarget[];
}

interface Dashboard {
  uid: string;
  panels: DashboardPanel[];
}

const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf8')) as Dashboard;

// Der Ausdrucks-STRING aus den Ein-Zeichen-Targets laesst sich wiederherstellen;
// dieser Helfer ist die Gegenprobe zum Defektmuster (Fragment vs. Ausdruck).
const joinExpressions = (panel: DashboardPanel): string =>
  (panel.targets ?? []).map((t) => t.expr ?? '').join('');

describe('Grafana-Dashboard-Vertrag · audiomonastry-overview', () => {
  it('ist syntaktisch gueltig und traegt die erwartete Struktur', () => {
    expect(dashboard.uid).toBe('audiomonastry-overview');
    expect(Array.isArray(dashboard.panels)).toBe(true);
    expect(dashboard.panels.length).toBe(22);
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
  });

  it('hat in JEDEM Panel Targets mit einer plausiblen PromQL-Form', () => {
    const violations: string[] = [];
    for (const panel of dashboard.panels) {
      const targets = panel.targets ?? [];
      if (targets.length === 0) {
        violations.push(`Panel ${panel.id} "${panel.title}": kein Target`);
        continue;
      }
      // Ein Panel braucht genau EINEN Ausdruck je Target - nicht EIN Zeichen je Target.
      // Obergrenze 4 laesst die legitimen A/B-Vergleichspanels (6, 7) zu, verhindert
      // aber ein Zurueckfallen in das Ein-Zeichen-Muster (36-108 Targets).
      if (targets.length > 4) {
        violations.push(`Panel ${panel.id} "${panel.title}": ${targets.length} Targets (Fragment-Muster?)`);
      }
      const refIds = new Set<string>();
      for (const [index, target] of targets.entries()) {
        const label = `Panel ${panel.id} "${panel.title}" Target ${index}`;
        const expr = (target.expr ?? '').trim();
        if (expr.length <= 8) {
          violations.push(`${label}: Ausdruck zu kurz (${JSON.stringify(target.expr)})`);
          continue;
        }
        // PromQL braucht mindestens eine Metrik-/Funktionsbezeichnung.
        if (!/[a-zA-Z_][a-zA-Z0-9_]*/.test(expr)) {
          violations.push(`${label}: keine Metrik-/Funktionsbezeichnung`);
        }
        // Klammern und Selektoren balanciert (Anfuehrungszeichen ausgenommen).
        const withoutStrings = expr.replace(/"[^"]*"/g, '""');
        const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
        const stack: string[] = [];
        for (const char of withoutStrings) {
          if (char in pairs) stack.push(pairs[char]);
          else if (')]}'.includes(char)) {
            if (stack.pop() !== char) violations.push(`${label}: unbalancierte Klammern (${expr})`);
          }
        }
        if (stack.length > 0) violations.push(`${label}: unbalancierte Klammern (${expr})`);
        // refId: Grafana erwartet A, B, C ... und je Panel nur einmal.
        if (!/^[A-Z]+$/.test(target.refId ?? '')) {
          violations.push(`${label}: ungueltige refId ${JSON.stringify(target.refId)}`);
        } else if (refIds.has(target.refId as string)) {
          violations.push(`${label}: refId ${target.refId} doppelt`);
        } else {
          refIds.add(target.refId as string);
        }
        // Datasource je Target UND je Panel zeigt auf die provisionierte Prometheus-Quelle.
        expect(target.datasource?.uid ?? panel.datasource?.uid).toBe('prometheus');
      }
    }
    expect(violations).toEqual([]);
  });

  it('verweist nur auf Metriken, die die App wirklich veroeffentlicht', () => {
    // Zwei Expositionen im Repo: die Node-Metriken der App und das
    // Latenz-Histogramm (Histogramm-Buckets entstehen erst zur Laufzeit).
    const published = [
      readFileSync('server/routes/opsRoutes.ts', 'utf8'),
      readFileSync('src/core/observability/latencyHistogram.ts', 'utf8'),
    ].join('\n');
    const unknown = new Set<string>();
    for (const panel of dashboard.panels) {
      const expr = joinExpressions(panel);
      // `audiomonastry_`-Praefix = von der App veroeffentlicht; Recording-Rules
      // heissen `audiomonastry:slo_...` und werden hier bewusst nicht geprueft.
      for (const match of expr.matchAll(/audiomonastry_[a-z0-9_]+/g)) {
        if (!published.includes(match[0])) unknown.add(`${match[0]} (Panel ${panel.id})`);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it('enthaelt die vier reparierten Ausdruecke unveraendert und vollstaendig', () => {
    // Frueher (Defekt) stand hier je Zeichen ein Target; jetzt genau EIN Target
    // mit dem ganzen Ausdruck. Das sind die Ausdruecke aus dem jeweiligen
    // Panel-Titel, gegengeprueft gegen scripts/hetzner/prometheus-alerts.yml.
    const expected: Record<number, string> = {
      19: 'increase(audiomonastry_ai_cost_usd[1h])',
      20: 'sum by (source) (rate(audiomonastry_telemetry_xruns_by_source_total[5m]))',
      21: 'sum(increase(audiomonastry_telemetry_xruns_total[10m]))',
      22: 'sum(rate(audiomonastry_http_errors_total[5m])) '
        + '/ clamp_min(sum(rate(audiomonastry_http_requests_total[5m])), 1e-9)',
    };
    for (const [id, expr] of Object.entries(expected)) {
      const panel = dashboard.panels.find((p) => p.id === Number(id));
      expect(panel, `Panel ${id} fehlt`).toBeDefined();
      expect(panel?.targets?.length, `Panel ${id} braucht genau ein Target`).toBe(1);
      expect(panel?.targets?.[0]?.expr).toBe(expr);
      expect(panel?.targets?.[0]?.refId).toBe('A');
    }
  });

  it('fuehrt keinen Ausdruck aus Ein-Zeichen-Fragmenten mehr', () => {
    // Gegenprobe zum Defektmuster: der zusammengesetzte Ausdruck eines Panels
    // darf nicht mehr aus lauter Ein-Zeichen-Targets bestehen.
    for (const panel of [19, 20, 21, 22].map((id) => dashboard.panels.find((p) => p.id === id))) {
      expect(panel).toBeDefined();
      const fragments = (panel?.targets ?? []).filter((t) => (t.expr ?? '').length === 1);
      expect(fragments).toEqual([]);
    }
  });
});
