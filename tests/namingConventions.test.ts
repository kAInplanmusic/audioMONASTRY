/**
 * NOMEN-P1-001 · Nomenklatur-Wächter
 * =====================================================================
 * Die Umbenennung `samplemonk` -> `audiomonastry` ist nur so viel wert wie ihre
 * Dauerhaftigkeit: ohne Wächter wandert der alte Name beim nächsten Copy-Paste
 * zurück in Metriken, Compose-Dateien oder Deploy-Skripte - und dann zeigt
 * entweder ein Dashboard nichts mehr an oder ein Skript spricht eine Ressource
 * an, die es nicht gibt.
 *
 * Deshalb prüft dieser Test JEDE getrackte Datei auf den alten Namen und lässt
 * nur eine begründete Ausnahmeliste zu:
 *
 *   - Bestands-Kompatibilität (laufende Installationen haben noch Alt-Namen;
 *     der Altname steht bewusst an genau EINER Stelle im jeweiligen Modul),
 *   - Test-Fixtures, die genau diese Kompatibilität abdecken,
 *   - historische Notizen in der SSOT (Audit-Regel: Vergangenes wird nicht
 *     umgeschrieben).
 *
 * Zusätzlich: die Metriknamen (Prometheus) dürfen den alten Präfix nirgends mehr
 * tragen - sie sind die Schnittstelle zu Dashboards und Alarmen.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Beide historischen Schreibweisen: `samplemonk` UND `sample-monk` (der
// Compose-Service hiess mit Bindestrich - genau das war der Rest, den die erste
// Suchrunde uebersehen hatte). Das Muster steht als Regex-Quelle im `git grep`
// weiter unten (DESIGN: eine Quelle statt zweier, die auseinanderlaufen).
const LEGACY_PATTERN = 'sample[-_]?monk';

/** Dateien, in denen der Altname bewusst stehen bleibt - mit Begründung. */
const ALLOWED: Record<string, string> = {
  'MASTERTODOENDE.json': 'Historische Notizen (Audit: Vergangenes wird nicht umgeschrieben).',
  'docs/HETZNER_DEPLOY.md': 'Migrationsliste alt -> neu + Betreiber-Schritte (nennt die Altwerte bewusst).',
  'tests/portalWorkerSnapshots.test.ts': 'Fixtures mit Alt-Namen + Tests der Kompatibilitaet.',
  'tests/fleetWiring.test.ts': 'Fixture einer Bestandsflotte (Alt-Namen in der Fleet-Map) + Kompatibilitaetstest.',
  'tests/test_hetzner_scripts.py': 'F10: Fixture eines Bestands-Knotens (Stack laeuft noch unter dem Altnamen) fuer den '
    + 'Watchdog-Test - der Altname steht dort BEWUSST als Literal in der Testfixture, nicht im Produktionscode. '
    + 'Eine Probe, die den Altnamen aus fleet-names.sh ableitet, wuerde sich selbst bestaetigen und nie auffallen.',
  'services/portal-worker/src/index.js': 'LEGACY_NAME_PREFIX / LEGACY_SNAPSHOT_PREFIXES (Bestandsressourcen).',
  'scripts/hetzner/fleet-names.sh': 'LEGACY_FLEET_PREFIX/LEGACY_COMPOSE_PROJECT/LEGACY_FLEET_HOME - die EINE Namens- '
    + 'und Pfadquelle (F10). Alle Skripte loesen ueber sie auf, damit der Altname nicht wandert.',
  'server/fleetWiring.ts': 'FLEET_LEGACY_NAME_PREFIX (Fleet-Map einer nicht aktualisierten Instanz).',
  'tests/namingConventions.test.ts': 'Der Waechter selbst - er dokumentiert und sucht den Altnamen.',
  'services/audiomonastry-ai-runtime/Dockerfile.manifest': 'Dokumentierter Alt-Basis-Image-Pfad als Build-Argument.',
  'docs/OPS_RUNBOOK.md': 'Live-Beweis-Kapitel 2026-09-18: beschreibt den TATSAECHLICHEN Zustand der laufenden '
    + 'Flotte (Snapshots "samplemonk-snapshot-*", Knotenpfad /opt/samplemonk, Floating-IP "samplemonk-floating", '
    + 'Fleet-Map des alten Workers) - ohne die Altnamen waere das Runbook falsch.',
  'docs/audit-infra-ARCHITEKTUR.md': 'Infra-Audit 2026-09-20: Belegkapitel nennt die real vorhandenen '
    + 'Bestandsressourcen ("samplemonk-snapshot-*", 12 Firewalls, 6x Legacy-Praefix) - Messergebnis, keine Nomenklatur.',
  'docs/audit-infra-hetzner.md': 'Infra-Audit 2026-09-20: Belegkapitel listet die tatsaechlichen Hetzner-Ressourcen '
    + '(10 Snapshots "samplemonk-snapshot-*", Firewall-Gruppen, /opt/samplemonk als Default-Ziel von fleet-deploy-live.sh) '
    + '- Messergebnis der laufenden Flotte, keine Nomenklatur.',
  'docs/FIXPLAN_2026-09-20_externer_apptest.md': 'Belegkapitel des externen App-Tests 2026-09-20 (F1-F10): nennt die '
    + 'real vorgefundenen Bestandsressourcen (/opt/samplemonk/certs, samplemonk-idle-shutdown.timer, Knotennamen '
    + 'samplemonk-* im Widerspruch zu audiomonastry-*) - Messergebnis, keine Nomenklatur. Der Befund wird nicht '
    + 'umgeschrieben, sonst waere das Belegkapitel falsch.',
};

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/**
 * Dateien mit dem Altnamen - per `git grep` statt jede Datei in JS zu lesen.
 *
 * WARUM: die erste Fassung las ALLE getrackten Dateien synchron. Mit wachsendem
 * Repo riss das unter voller Suite-Last das 15-s-Testlimit ("Test timed out in
 * 15000ms") - ein Waechter, der sporadisch rot wird, wird abgeschaltet. `git grep`
 * ist um Groessenordnungen schneller und liefert dieselbe Aussage.
 */
function filesWithLegacyName(): string[] {
  try {
    return execFileSync('git', ['grep', '-l', '-I', '-i', '-E', LEGACY_PATTERN, '--', '.'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      // `git grep` liefert "./pfad" - die Ausnahmeliste ist ohne Praefix.
      .map((f) => f.replace(/^\.\//, ''));
  } catch (err) {
    // git grep endet mit Exit 1, wenn es KEINEN Treffer gibt - das ist der Idealfall.
    const status = (err as { status?: number }).status;
    if (status === 1) return [];
    throw err;
  }
}

describe('NOMEN-P1-001 · Nomenklatur', () => {
  const files = trackedFiles();

  it('findet den Altnamen nur in begruendeten Ausnahmen', () => {
    const hits = filesWithLegacyName().filter((file) => !ALLOWED[file]);
    expect(hits).toEqual([]);
  });

  it('haelt die Ausnahmeliste aktuell (keine veralteten Eintraege)', () => {
    // Eine Ausnahme, die niemand mehr braucht, ist eine offene Flanke: sie
    // erlaubt den Altnamen an einer Stelle, an der er gar nicht mehr vorkommt.
    const withLegacy = new Set(filesWithLegacyName());
    const stale = Object.keys(ALLOWED).filter((file) => !withLegacy.has(file));
    expect(stale).toEqual([]);
  });

  it('verwendet den alten Praefix in keinem Prometheus-Metriknamen mehr', () => {
    const metricFiles = files.filter((f) =>
      /opsRoutes\.ts|latencyHistogram\.ts/.test(f)
      || f.startsWith('scripts/hetzner/prometheus')
      || f.startsWith('scripts/hetzner/grafana')
      || f.endsWith('grafana-dashboards/audiomonastry-overview.json'),
    );
    expect(metricFiles.length).toBeGreaterThan(4);
    const withLegacyMetric = metricFiles.filter((f) => /samplemonk_/.test(readFileSync(f, 'utf8')));
    expect(withLegacyMetric).toEqual([]);
  });

  it('nennt die Metriken, Jobs und Alarme durchgaengig audiomonastry_*', () => {
    const ops = readFileSync('server/routes/opsRoutes.ts', 'utf8');
    expect(ops).toContain('audiomonastry_http_requests_total');
    expect(ops).toContain('audiomonastry_ai_cost_usd');
    expect(ops).not.toMatch(/samplemonk_/);

    const histogram = readFileSync('src/core/observability/latencyHistogram.ts', 'utf8');
    expect(histogram).toContain('audiomonastry_http_request_duration_seconds');
    expect(histogram).not.toMatch(/samplemonk_/);

    const alerts = readFileSync('scripts/hetzner/prometheus-alerts.yml', 'utf8');
    expect(alerts).toContain('AudiomonastrySloAvailabilityBreach');
    expect(alerts).toContain('audiomonastry_http_requests_total');
    expect(alerts).not.toMatch(/samplemonk/i);

    const prometheus = readFileSync('scripts/hetzner/prometheus.yml', 'utf8');
    expect(prometheus).toContain("job_name: 'audiomonastry'");
    expect(prometheus).not.toMatch(/\bsamplemonk\b/i);

    const dashboard = readFileSync('scripts/hetzner/grafana-dashboards/audiomonastry-overview.json', 'utf8');
    expect(dashboard).toContain('audiomonastry_http_requests_total');
    expect(dashboard).not.toMatch(/samplemonk/i);
  });

  it('haelt die Ops-Ressourcennamen (Compose, Units, Images, Snapshot-Praefix) konsistent', () => {
    const compose = readFileSync('docker-compose.hetzner.yml', 'utf8');
    expect(compose).toContain('container_name: audiomonastry');
    expect(compose).toContain('audiomonastry-master-player:hetzner');
    expect(compose).not.toMatch(/samplemonk/i);

    const deploy = readFileSync('deploy.sh', 'utf8');
    expect(deploy).toContain('audiomonastry:hetzner');
    expect(deploy).toContain('audiomonastry-master-player:hetzner');
    expect(deploy).not.toMatch(/samplemonk/i);

    const portal = readFileSync('services/portal-worker/src/index.js', 'utf8');
    // Neuer Praefix wird ANGELEGT, der Altpraefix nur noch akzeptiert.
    expect(portal).toContain("const NAME_PREFIX = 'audiomonastry-'");
    expect(portal).toContain("const SNAPSHOT_PREFIX = 'audiomonastry-snapshot-'");
    expect(portal).toContain('LEGACY_SNAPSHOT_PREFIXES');

    // systemd-Units heissen ebenfalls neu.
    const idleCheck = readFileSync('scripts/hetzner/systemd/idle-check.sh', 'utf8');
    expect(idleCheck).not.toMatch(/samplemonk/i);
  });
});
