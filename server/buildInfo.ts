/**
 * audioMONASTRY · Build-Metadaten und Commit-Paritaet (PROD-P1-F4)
 * ================================================================================
 * Warum es diese Datei gibt:
 *
 * Die Build-Version allein (package.json: `1.210.001`) aendert sich nicht mit
 * jedem Commit. Ein Deploy-/Rollback-Vergleich war damit nicht belegbar, und
 * eine veraltete Flotte blieb unsichtbar - im Befund vom 2026-09-20 lief app-1
 * auf einem Image vom 18.09., waehrend das Repo (Commit `ae5e749`, 20.09.) zwei
 * Tage weiter war. Genau dieser Drift brach den Session-Clock-Sync, ohne dass
 * ein Endpunkt das gemeldet haette (`/api/health` sagte nur `{"status":"ok",
 * "version":"1.210.001"}`).
 *
 * Deshalb setzt `deploy.sh` drei Werte als Build-Args, `Dockerfile.hetzner`
 * legt sie im Runtime-Stage als ENV ab und der Container nennt sie hier:
 *   AUDIOMONASTRY_VERSION     Release-Version aus package.json
 *   AUDIOMONASTRY_COMMIT      kurzer Commit-SHA des Repo-Stands (Build-Quelle)
 *   AUDIOMONASTRY_BUILD_TIME  Build-Zeit, UTC, ISO-8601
 *
 * `/api/health` gibt sie als `version`, `commit`, `buildTime` aus - additiv,
 * keine Secrets, keine Keys. Fehlt ein Wert (Image vor F4 gebaut), steht
 * `unknown`/`dev` da; das Staleness-Gate meldet das als "nicht pruefbar"
 * statt eine Paritaet zu behaupten.
 *
 * Die VergleichsREGEL (kurzer SHA trifft langen SHA) liegt bewusst mehrfach im
 * Repo, weil die Ausfuehrungsorte getrennt sind:
 *   * hier (`compareCommits`) fuer Server und Tests,
 *   * `commitParity()` im Portal-Worker (services/portal-worker/src/index.js,
 *     kann kein TypeScript importieren),
 *   * `build_parity_report` in scripts/hetzner/lib/build-parity.sh (deploy.sh,
 *     fleet-preflight.sh, tests/test_hetzner_scripts.py).
 * Alle drei muessen dieselbe Antwort liefern - die Tests
 * (tests/buildInfo.test.ts, tests/portalWorkerStaleness.test.ts,
 * tests/test_hetzner_scripts.py) halten das fest.
 */

/** Build-Metadaten, wie sie im Container aus der Umgebung gelesen werden. */
export interface BuildInfo {
  /** Release-Version (package.json), `dev` ohne Stempel. */
  version: string;
  /** Kurzer Commit-SHA des Repo-Stands, `unknown` ohne Build-Arg. */
  commit: string;
  /** Build-Zeit (UTC, ISO-8601), `unknown` ohne Build-Arg. */
  buildTime: string;
}

/** Platzhalter, wenn das Image ohne Build-Arg gebaut wurde (vor F4). */
export const UNKNOWN_BUILD_VALUE = 'unknown';

/** Version-Fallback ausserhalb eines gestempelten Images (PROD-P0-003). */
export const FALLBACK_BUILD_VERSION = 'dev';

/** Werte, die KEIN Commit sind (Platzhalter/JSON-Reste) - nicht vergleichbar. */
const NON_COMMIT_VALUES = new Set(['', UNKNOWN_BUILD_VALUE, FALLBACK_BUILD_VERSION, 'none', 'null']);

/**
 * Build-Metadaten aus der Prozessumgebung lesen.
 *
 * Absichtlich ohne `process.env`-Zugriff im Modulkopf: der Aufrufer reicht die
 * Quelle herein (Default = `process.env`), damit die Aufloesung ohne gesetzte
 * Umgebung testbar ist.
 */
export function readBuildInfo(
  env: Record<string, string | undefined> = process.env,
): BuildInfo {
  const pick = (raw: string | undefined, fallback: string): string => {
    const value = String(raw ?? '').trim();
    return value === '' ? fallback : value;
  };
  return {
    version: pick(env.AUDIOMONASTRY_VERSION, FALLBACK_BUILD_VERSION),
    commit: pick(env.AUDIOMONASTRY_COMMIT, UNKNOWN_BUILD_VALUE),
    buildTime: pick(env.AUDIOMONASTRY_BUILD_TIME, UNKNOWN_BUILD_VALUE),
  };
}

/** Kurzform eines Commits zum Vergleich (leer = nicht verwertbar). */
export function normalizeCommit(value: string | null | undefined): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (NON_COMMIT_VALUES.has(raw)) return '';
  return raw.slice(0, 40);
}

/** Ergebnis einer Commit-Paritaetspruefung (gleiche Form wie im Portal-Worker). */
export interface CommitParity {
  /** true = kein nachgewiesener Unterschied (auch "nicht pruefbar"). */
  ok: boolean;
  /** true = es gab eine Erwartung UND einen gemeldeten Commit. */
  checked: boolean;
  expected: string | null;
  actual: string | null;
  message: string;
}

/**
 * Staleness-Regel: erwarteter Commit (Repo/Release) gegen gemeldeten Commit
 * (`/api/health`, Snapshot-Label). Ein kurzer SHA darf dabei auf einen langen
 * treffen - verglichen wird deshalb per Prefix, nicht per Gleichheit.
 *
 * "Nicht pruefbar" ist bewusst KEIN Fehler (`ok: true`, `checked: false`): ein
 * vor F4 gebautes Image ohne `commit`-Feld darf keinen Alarm ausloesen, es wird
 * aber laut gemeldet. Bloss nicht weiterpruefen darf man es.
 *
 * `source` benennt die Quelle des gemeldeten Stands (`health`, `snapshot`) und
 * landet im Klartext der Meldung.
 */
export function compareCommits(
  expected: string | null | undefined,
  actual: string | null | undefined,
  source = 'health',
): CommitParity {
  const want = normalizeCommit(expected);
  const have = normalizeCommit(actual);
  if (!want) {
    return {
      ok: true,
      checked: false,
      expected: null,
      actual: have || null,
      message: 'Kein erwarteter Commit gesetzt - Stand der Flotte nicht vergleichbar.',
    };
  }
  if (!have) {
    return {
      ok: true,
      checked: false,
      expected: want,
      actual: null,
      message: `Flotte meldet keinen Commit (${source}) - erwartet ${want}, nicht pruefbar.`,
    };
  }
  const ok = have.startsWith(want) || want.startsWith(have);
  return {
    ok,
    checked: true,
    expected: want,
    actual: have,
    message: ok
      ? `Commit-Paritaet ok (${want}).`
      : `Flotte laeuft Stand ${have}, Repo ist ${want}.`,
  };
}
