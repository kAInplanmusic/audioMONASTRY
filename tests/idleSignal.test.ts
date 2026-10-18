/**
 * F9 · Idle-Shutdown-Signal
 * =========================
 * Befund (docs/FIXPLAN_2026-09-20_externer_apptest.md, F9): Der systemd-Timer der
 * Hetzner-Rolle feuerte gegen ein Primärsignal, das **strukturell immer 0** war
 * (`curl http://127.0.0.1/api/online` → Caddy-308 bzw. 401 ohne Token; beides
 * endete in der 0 des awk-END-Blocks), und das Log zeigte ausnahmslos `ONLINE=0`.
 *
 * Teil 1 prüft die ENTSCHEIDUNG als reine Funktion — genau die Fälle, die das
 * Signal tragen muss:
 *   * offene Sockets            → aktiv, kein Shutdown
 *   * kürzlicher App-Request    → aktiv, kein Shutdown
 *   * alles leer                → idle, Shutdown NACH der Schwelle (und nicht vorher)
 *   * aktive Socket-Clients     → aktiv (die Sockets sind die zweite Saeule)
 *   * App-Signal unlesbar       → `unknown` → KEIN Shutdown (fail-safe)
 *   * Log-Zeile                 → echte Zahlen + ISO-Zeitstempel
 *
 * Teil 2 prüft die Kette über echtes HTTP gegen den Server: letzter erfolgreicher
 * App-Request (Middleware) + Socket-Messwert + Entscheidung + `logLine`. Damit ist
 * belegt, dass der Timer echte Zahlen bekommt — im Gegensatz zum Vorzustand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_IDLE_SHUTDOWN_MINUTES,
  IDLE_THRESHOLD_MAX_SECONDS,
  IDLE_THRESHOLD_MIN_SECONDS,
  clampIdleThresholdSeconds,
  createIdleWatcher,
  decideIdleShutdown,
  evaluateIdleSignal,
  formatIdleLogLine,
  isAppActivityRequest,
  parseIdleHostFacts,
  resolveIdleThresholdMs,
  type IdleSignalFacts,
} from '../server/idleSignal';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 20, 18, 0, 0);

/** Fakten-Basis: ruhiger Knoten, letzte Nutzung `ageMs` her. */
function facts(overrides: Partial<IdleSignalFacts> = {}): IdleSignalFacts {
  return {
    nowMs: NOW,
    onlineSockets: 0,
    openSockets: 0,
    sshSessions: 0,
    load1: 0,
    busyContainers: 0,
    lastActivityAtMs: NOW - 40 * MINUTE,
    startedAtMs: NOW - 6 * 60 * MINUTE,
    idleThresholdMs: 30 * MINUTE,
    signalOk: true,
    ...overrides,
  };
}

describe('F9: Idle-Entscheidung (reine Funktion)', () => {
  it('offene Sockets → aktiv, kein Shutdown', () => {
    const evaluation = evaluateIdleSignal(facts({ openSockets: 2 }));
    expect(evaluation.verdict).toBe('active');
    expect(evaluation.reasons).toContain('offene-sockets=2');
    expect(decideIdleShutdown({ evaluation, idleForMs: 3 * 60 * MINUTE, idleThresholdMs: 30 * MINUTE }).shutdown).toBe(false);
  });

  it('kürzlicher Request → aktiv, kein Shutdown', () => {
    const evaluation = evaluateIdleSignal(facts({ lastActivityAtMs: NOW - 10_000 }));
    expect(evaluation.verdict).toBe('active');
    expect(evaluation.reasons).toContain('request-vor-10s');
    expect(evaluation.activityAgeMs).toBe(10_000);
    expect(decideIdleShutdown({ evaluation, idleForMs: 3 * 60 * MINUTE, idleThresholdMs: 30 * MINUTE }).shutdown).toBe(false);
  });

  it('aktive Socket-Clients → aktiv (online ist eine echte Saeule des Signals)', () => {
    const evaluation = evaluateIdleSignal(facts({ onlineSockets: 1 }));
    expect(evaluation.verdict).toBe('active');
    expect(evaluation.reasons).toContain('online-sockets=1');
  });

  it('alles leer, letzte Nutzung alt → idle; Shutdown erst NACH der Schwelle', () => {
    const evaluation = evaluateIdleSignal(facts());
    expect(evaluation.verdict).toBe('idle');
    expect(evaluation.idle).toBe(true);
    // 29 min idle: noch kein Shutdown …
    expect(decideIdleShutdown({ evaluation, idleForMs: 29 * MINUTE, idleThresholdMs: 30 * MINUTE }).shutdown).toBe(false);
    // … 30 min: Shutdown, mit Begruendung in Zahlen.
    const decision = decideIdleShutdown({ evaluation, idleForMs: 30 * MINUTE, idleThresholdMs: 30 * MINUTE });
    expect(decision.shutdown).toBe(true);
    expect(decision.reason).toMatch(/idle seit 1800s >= Schwelle 1800s/);
  });

  it('kein Request seit Prozessstart: die Uhr laeuft ab dem Start, nicht ab „nie“', () => {
    const evaluation = evaluateIdleSignal(facts({
      lastActivityAtMs: null,
      startedAtMs: NOW - 31 * MINUTE,
    }));
    expect(evaluation.verdict).toBe('idle');
    expect(evaluation.activityAgeMs).toBe(31 * MINUTE);
  });

  it('unlesbares App-Signal → unknown → KEIN Shutdown (fail-safe)', () => {
    const evaluation = evaluateIdleSignal(facts({ signalOk: false, openSockets: 0 }));
    expect(evaluation.verdict).toBe('unknown');
    expect(evaluation.idle).toBe(false);
    const decision = decideIdleShutdown({ evaluation, idleForMs: 10 * 60 * MINUTE, idleThresholdMs: 30 * MINUTE });
    expect(decision.shutdown).toBe(false);
    expect(decision.reason).toMatch(/fail-safe/);
  });

  it('SSH-Session, Load und beschaeftigte Container halten die Instanz ebenfalls wach', () => {
    for (const override of [{ sshSessions: 1 }, { load1: 2 }, { busyContainers: 1 }]) {
      const evaluation = evaluateIdleSignal(facts(override));
      expect(evaluation.verdict).toBe('active');
    }
  });

  it('Watcher fuehrt die Idle-Dauer ueber Abrufe hinweg und setzt sie bei Aktivitaet zurueck', () => {
    const watcher = createIdleWatcher();
    const first = watcher.evaluate(facts({ idleThresholdMs: 30 * MINUTE }));
    expect(first.evaluation.idle).toBe(true);
    expect(first.idleForMs).toBe(0); // frisch idle: die Frist beginnt jetzt
    expect(first.decision.shutdown).toBe(false);

    const later = watcher.evaluate(facts({ nowMs: NOW + 30 * MINUTE, idleThresholdMs: 30 * MINUTE }));
    expect(later.idleForMs).toBe(30 * MINUTE);
    expect(later.decision.shutdown).toBe(true);

    // Nutzung dazwischen → Uhr zurueck auf 0.
    const active = watcher.evaluate(facts({ nowMs: NOW + 31 * MINUTE, lastActivityAtMs: NOW + 31 * MINUTE }));
    expect(active.evaluation.verdict).toBe('active');
    expect(active.idleForMs).toBe(0);
    const idleAgain = watcher.evaluate(facts({ nowMs: NOW + 32 * MINUTE }));
    expect(idleAgain.evaluation.verdict).toBe('idle');
    expect(idleAgain.idleForMs).toBe(0);
  });

  it('Log-Zeile enthaelt echte Zahlen und Zeitstempel', () => {
    const line = formatIdleLogLine({
      nowMs: NOW,
      facts: facts({ openSockets: 2 }),
      evaluation: evaluateIdleSignal(facts({ openSockets: 2 })),
      idleForMs: 0,
      decision: { shutdown: false, reason: 'aktiv: offene-sockets=2' },
    });
    expect(line).toContain('[idle-check] 2026-09-20T18:00:00.000Z');
    expect(line).toContain('ONLINE=0');
    expect(line).toContain('OPEN_SOCKETS=2');
    expect(line).toContain('LAST_ACTIVITY=2026-09-20T17:20:00.000Z');
    expect(line).toContain('ACTIVITY_AGE=2400s');
    expect(line).toContain('THRESHOLD=1800s');
    expect(line).toContain('VERDICT=active');
    expect(line).toContain('SHUTDOWN=no');
  });

  it('Monitoring-Pfade zaehlen nicht als App-Nutzung (sonst halten sich Scrapes selbst wach)', () => {
    expect(isAppActivityRequest('GET', '/api/health')).toBe(false);
    expect(isAppActivityRequest('GET', '/api/metrics')).toBe(false);
    expect(isAppActivityRequest('GET', '/api/online')).toBe(false);
    expect(isAppActivityRequest('GET', '/api/idle-signal?openSockets=0')).toBe(false);
    expect(isAppActivityRequest('HEAD', '/api/stem/status')).toBe(false);
    expect(isAppActivityRequest('GET', '/api/plugin/state')).toBe(true);
    expect(isAppActivityRequest('POST', '/api/telemetry')).toBe(true);
    expect(isAppActivityRequest('GET', '/')).toBe(true);
  });

  it('Schwelle: explizite Timer-Angabe schlaegt den Env-Default – nur innerhalb der harten Grenzen', () => {
    // DA-2026-10-17-004: < 60 s wird verworfen, die Entscheidung faellt auf den
    // Server-Default zurueck (kein clientgesteuerter Sofort-Shutdown).
    expect(resolveIdleThresholdMs(45, 10)).toBe(10 * MINUTE);
    expect(resolveIdleThresholdMs(60, 10)).toBe(60_000);
    expect(resolveIdleThresholdMs(120, 10)).toBe(120_000);
    expect(resolveIdleThresholdMs(86_400, 10)).toBe(86_400_000);
    expect(resolveIdleThresholdMs(86_401, 10)).toBe(10 * MINUTE);
    expect(resolveIdleThresholdMs(null, 10)).toBe(10 * MINUTE);
    expect(resolveIdleThresholdMs(undefined, undefined)).toBe(DEFAULT_IDLE_SHUTDOWN_MINUTES * MINUTE);
    expect(resolveIdleThresholdMs('quatsch', '0')).toBe(DEFAULT_IDLE_SHUTDOWN_MINUTES * MINUTE);
  });

  it('Host-Fakten aus der Query: unlesbare Werte werden zu 0, keine Phantom-Aktivitaet', () => {
    const parsed = parseIdleHostFacts({ openSockets: '3', sshSessions: 'x', load1: '-1', busyContainers: '1', thresholdSec: '60' });
    expect(parsed).toEqual({ openSockets: 3, sshSessions: 0, load1: 0, busyContainers: 1, thresholdSeconds: 60 });
    expect(parseIdleHostFacts({}).thresholdSeconds).toBeNull();
  });

  /**
   * DA-2026-10-17-004
   * =================
   * Befund: `thresholdSec` kam ungeprüft aus dem Query-String und überschrieb die
   * serverseitige `IDLE_SHUTDOWN_MINUTES`. Ein authentifizierter Client konnte den
   * Knoten mit `thresholdSec=1` in Sekunden abschalten.
   *
   * Vertrag jetzt: hart auf [60 s, 86400 s] begrenzt; alles andere → null, damit
   * die Route den Server-Default nimmt.
   */
  it('thresholdSec wird hart begrenzt (60 s … 86400 s), alles andere → Default', () => {
    expect(IDLE_THRESHOLD_MIN_SECONDS).toBe(60);
    expect(IDLE_THRESHOLD_MAX_SECONDS).toBe(86_400);

    // Der Angriff aus dem Audit: 1 s darf NIE durchkommen.
    expect(parseIdleHostFacts({ thresholdSec: '1' }).thresholdSeconds).toBeNull();
    expect(parseIdleHostFacts({ thresholdSec: 1 }).thresholdSeconds).toBeNull();
    expect(parseIdleHostFacts({ thresholdSec: '59.9' }).thresholdSeconds).toBeNull();
    expect(parseIdleHostFacts({ thresholdSec: '0' }).thresholdSeconds).toBeNull();
    expect(parseIdleHostFacts({ thresholdSec: '-60' }).thresholdSeconds).toBeNull();

    // Grenzen sind inklusiv.
    expect(parseIdleHostFacts({ thresholdSec: '60' }).thresholdSeconds).toBe(60);
    expect(parseIdleHostFacts({ thresholdSec: '86400' }).thresholdSeconds).toBe(86_400);

    // Obergrenze: ein absurd grosser Wert schaltet den Shutdown nicht faktisch ab.
    expect(parseIdleHostFacts({ thresholdSec: '86401' }).thresholdSeconds).toBeNull();
    expect(parseIdleHostFacts({ thresholdSec: '1e9' }).thresholdSeconds).toBeNull();

    // Unlesbares/fehlendes bleibt null (Route → Env-Default).
    expect(parseIdleHostFacts({ thresholdSec: 'quatsch' }).thresholdSeconds).toBeNull();
    expect(parseIdleHostFacts({ thresholdSec: '' }).thresholdSeconds).toBeNull();
    expect(parseIdleHostFacts({ thresholdSec: null }).thresholdSeconds).toBeNull();
    expect(parseIdleHostFacts({}).thresholdSeconds).toBeNull();

    expect(clampIdleThresholdSeconds('120')).toBe(120);
    expect(clampIdleThresholdSeconds(Number.NaN)).toBeNull();
    expect(clampIdleThresholdSeconds(undefined)).toBeNull();
  });
});

// --- Integrationslauf: der Endpunkt, den der Timer jetzt fragt ----------------
process.env.VITEST = 'true';
process.env.NODE_ENV = 'test';
process.env.IDLE_SHUTDOWN_MINUTES = '30';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const mod = await import('../server');
  server = await new Promise<Server>((resolve) => {
    const started = mod.app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface IdleSignalBody {
  status: string;
  verdict: string;
  idle: boolean;
  shutdown: boolean;
  reason: string;
  online: number;
  openSockets: number;
  activityAgeSec: number;
  idleForSec: number;
  idleThresholdSec: number;
  lastActivityAt: string | null;
  socketGhosts: number;
  logLine: string;
}

const idleSignal = async (query = ''): Promise<IdleSignalBody> => {
  const res = await fetch(`${baseUrl}/api/idle-signal${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as IdleSignalBody;
};

describe('F9: /api/idle-signal über echtes HTTP (der Timer fragt jetzt hier)', () => {
  it('liefert echte Zahlen statt eines strukturellen ONLINE=0', async () => {
    const body = await idleSignal();
    expect(body.status).toBe('ok');
    expect(typeof body.online).toBe('number');
    expect(body.online).toBe(0); // niemand verbunden — das ist eine Messung, keine Konstante
    expect(typeof body.activityAgeSec).toBe('number');
    expect(body.idleThresholdSec).toBe(30 * 60);
    expect(typeof body.logLine).toBe('string');
    expect(body.logLine).toContain('THRESHOLD=1800s');
    expect(body.logLine).toMatch(/\[idle-check\] \d{4}-\d{2}-\d{2}T/);
  });

  it('format=text + Header sind der Vertrag des Timers (eine Entscheidung, zwei Formate)', async () => {
    const res = await fetch(`${baseUrl}/api/idle-signal?thresholdSec=60&format=text`);
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type'))).toContain('text/plain');
    const line = (await res.text()).trim();
    expect(line).toMatch(/^\[idle-check\] \d{4}-\d{2}-\d{2}T/);
    expect(line).toContain('SHUTDOWN=');
    expect(['yes', 'no']).toContain(res.headers.get('x-idle-shutdown'));
    expect(['active', 'idle', 'unknown']).toContain(res.headers.get('x-idle-verdict'));
    // Zeile und Header stammen aus derselben Entscheidung (kein zweiter Rechenweg).
    expect(line).toContain(`SHUTDOWN=${res.headers.get('x-idle-shutdown')}`);
    expect(line).toContain(`VERDICT=${res.headers.get('x-idle-verdict')}`);
    // 60 s ist die untere harte Grenze und wird als Client-Schwelle akzeptiert
    // (DA-2026-10-17-004: darunter wird verworfen).
    expect(line).toContain('THRESHOLD=60s');
  });

  it('Host-Fakten des Timers fliessen in die Entscheidung ein', async () => {
    const body = await idleSignal('?openSockets=4&sshSessions=1&thresholdSec=1');
    expect(body.verdict).toBe('active');
    expect(body.openSockets).toBe(4);
    expect(body.reason).toMatch(/offene-sockets=4/);
    expect(body.shutdown).toBe(false);
    // DA-2026-10-17-004: thresholdSec=1 wird verworfen; es gilt die Server-Env
    // (30 min), nicht die Client-Angabe.
    expect(body.idleThresholdSec).toBe(30 * 60);
  });

  it('thresholdSec aus der Query kann den Knoten nicht sofort abschalten (DA-2026-10-17-004)', async () => {
    // Der Audit-Angriff: ein Client mit gültigem Token setzt thresholdSec=1.
    const tiny = await idleSignal('?thresholdSec=1');
    expect(tiny.idleThresholdSec).toBe(30 * 60);
    expect(tiny.shutdown).toBe(false);

    // Auch ein absurd grosser Wert wird verworfen (Kostenbremse bleibt scharf).
    const huge = await idleSignal('?thresholdSec=999999');
    expect(huge.idleThresholdSec).toBe(30 * 60);

    // Innerhalb der Grenzen bleibt die Timer-Angabe wirksam.
    const valid = await idleSignal('?thresholdSec=120');
    expect(valid.idleThresholdSec).toBe(120);
    expect(valid.shutdown).toBe(false);
  });

  it('leerer Knoten: erst idle, nach dem Intervall Shutdown=yes (mit Begruendung)', async () => {
    // DA-2026-10-17-004: thresholdSec < 60 s wird nicht mehr akzeptiert. Den
    // Trockenlauf-Fall (wenige Sekunden) bildet jetzt die Server-Env ab – die
    // systemd-Unit erlaubt dort bewusst Bruchteile von Minuten (0.05 = 3 s).
    const previous = process.env.IDLE_SHUTDOWN_MINUTES;
    process.env.IDLE_SHUTDOWN_MINUTES = '0.02'; // 1,2 s
    try {
      // Ausgangspunkt eindeutig machen: eine echte App-Nutzung setzt die Uhr.
      const activity = await fetch(`${baseUrl}/api/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [{ type: 'f8f9-test', source: 'test', message: 'Startpunkt' }] }),
      });
      expect(activity.status).toBe(202);

      // Schwelle 1,2 s, damit der Test die SCHWELLE prueft und nicht 30 Minuten wartet.
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      const firstIdle = await idleSignal();
      // Der Request oben ist laenger her ⇒ idle (Idle-Uhr startet jetzt).
      expect(firstIdle.verdict).toBe('idle');
      expect(firstIdle.shutdown).toBe(false);
      expect(firstIdle.idleForSec).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 1_400));
      const shutdown = await idleSignal();
      expect(shutdown.verdict).toBe('idle');
      expect(shutdown.shutdown).toBe(true);
      expect(shutdown.reason).toMatch(/>= Schwelle/);
      expect(shutdown.logLine).toContain('SHUTDOWN=yes');
      expect(shutdown.logLine).toContain('VERDICT=idle');
      expect(shutdown.idleThresholdSec).toBe(1); // 0.02 min = 1200 ms → 1 s (gerundet)
    } finally {
      if (previous === undefined) delete process.env.IDLE_SHUTDOWN_MINUTES;
      else process.env.IDLE_SHUTDOWN_MINUTES = previous;
    }
  });

  it('ein erfolgreicher App-Request setzt das Signal sofort zurück (kein Shutdown mitten im Betrieb)', async () => {
    const previous = process.env.IDLE_SHUTDOWN_MINUTES;
    process.env.IDLE_SHUTDOWN_MINUTES = '0.02'; // 1,2 s – gleiche Begruendung wie oben
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      const before = await idleSignal();
      expect(before.verdict).toBe('idle');

      // Erfolgreicher, NICHT-Monitoring-Request = App-Nutzung.
      const activity = await fetch(`${baseUrl}/api/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [{ type: 'f8f9-test', source: 'test', message: 'Nutzer aktiv' }] }),
      });
      expect(activity.status).toBe(202);

      const after = await idleSignal();
      expect(after.verdict).toBe('active');
      expect(after.shutdown).toBe(false);
      expect(after.activityAgeSec).toBeLessThanOrEqual(1);
      expect(after.lastActivityAt).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.IDLE_SHUTDOWN_MINUTES;
      else process.env.IDLE_SHUTDOWN_MINUTES = previous;
    }
  });
});
