/**
 * audioMONASTRY · Kill-Switch (RC1-003)
 * ================================================================================
 * Warum es diese Datei gibt:
 *
 * Der Audit vom 2026-09-23 hat gemessen, dass es KEINEN Laufzeit-Schalter gibt:
 * `src/config/featureFlags.ts` ist eine hartkodierte Client-Konstante
 * (`VOICE_GENERATOR_ENABLED: true`, …), und der einzige echte ENV-Schalter im
 * Server war `ENABLE_SFU=1` - der aber nur die SFU betrifft. Wer den Dienst
 * sofort anhalten muss (Kostenausreisser, Missbrauch, Vorfall), hatte dafuer
 * keinen Hebel ausser Flotte zerstoeren oder Prozess killen. Beides ist grob.
 *
 * Dieser Schalter ist bewusst die kleinste wirksame Massnahme:
 *   * Er wird aus der UMWELT gelesen (`KILL_SWITCH` oder `MAINTENANCE_MODE`),
 *     nicht aus dem Code - kein Redeploy, nur ein Container-Restart.
 *   * Er sperrt ausschliesslich `/api/*` (dort starten alle Auftraege, allen
 *     voran `/api/ai/*` und damit jeder RunPod-Kostenpfad) und antwortet 503.
 *   * Er laesst `/api/health` und `/api/metrics` ABSICHTLICH erreichbar: sonst
 *     sieht das Monitoring im Wartungszustand nur einen toten Host und kann
 *     "absichtlich angehalten" nicht von "abgestuerzt" unterscheiden.
 *   * Er laesst die SPA/Assets ausliefern, damit der Nutzer eine erklaerende
 *     Oberflaeche sieht statt eines nackten 503.
 *
 * Nicht enthalten (bewusst): Socket.io. Bestehende Sessions duerfen ihren
 * Zustand weiter spiegeln - ein Kill-Switch, der die Verbindungen abreisst,
 * macht aus einem Kostenstopp einen Datenverlust. Neue ARBEIT entsteht ueber
 * `/api/*`, und genau das ist gesperrt.
 *
 * Die Logik ist rein (kein Express-Import), damit sie ohne Server testbar ist.
 */

/** Umgebungsvariablen, die den Schalter ausloesen (erste gesetzte gewinnt). */
export const KILL_SWITCH_ENV_KEYS = ['KILL_SWITCH', 'MAINTENANCE_MODE'] as const;

/** Werte, die als "ein" gelten. Alles andere (auch '0', 'false', '') ist aus. */
const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled', 'an', 'ja']);

/** Maschinenlesbarer Code fuer Clients/Alarme. */
export const KILL_SWITCH_CODE = 'KILL_SWITCH';

/** HTTP-Status im Wartungszustand (Dienst voruebergehend nicht verfuegbar). */
export const KILL_SWITCH_STATUS = 503;

/** Empfehlung an Clients/Alarme, wann erneut versucht werden soll (Sekunden). */
export const KILL_SWITCH_RETRY_AFTER_SECONDS = 300;

/**
 * Pfade, die auch im Wartungszustand erreichbar bleiben MUESSEN.
 * `/api/health` = Liveness/Rollback-Nachweis, `/api/metrics` = Prometheus-Scrape.
 * Der CSP-Meldeweg kommt zur Laufzeit dazu (siehe `killSwitchAllowedPaths`).
 */
export const KILL_SWITCH_BASE_ALLOWED_PATHS = ['/api/health', '/api/metrics'] as const;

/** Ist der Schalter in dieser Umgebung aktiv? */
export function isKillSwitchActive(env: Record<string, string | undefined> = process.env): boolean {
  for (const key of KILL_SWITCH_ENV_KEYS) {
    const raw = String(env[key] ?? '').trim().toLowerCase();
    if (raw !== '' && TRUTHY_VALUES.has(raw)) return true;
  }
  return false;
}

/** Welche ENV-Variable hat den Schalter ausgeloest? (fuer die Startmeldung) */
export function killSwitchSource(env: Record<string, string | undefined> = process.env): string | null {
  for (const key of KILL_SWITCH_ENV_KEYS) {
    const raw = String(env[key] ?? '').trim().toLowerCase();
    if (raw !== '' && TRUTHY_VALUES.has(raw)) return key;
  }
  return null;
}

/** Erreichbare Pfade inkl. CSP-Meldeweg (wird hereingereicht, kein Import-Zyklus). */
export function killSwitchAllowedPaths(cspReportPath?: string): string[] {
  // Explizit als string[]: KILL_SWITCH_BASE_ALLOWED_PATHS ist `as const`, sonst
  // waere `paths` auf das Literal-Union der beiden Basis-Pfade verengt und das
  // Anhaengen des CSP-Pfads ein Typfehler (von tsc gefunden, 2026-09-23).
  const paths: string[] = [...KILL_SWITCH_BASE_ALLOWED_PATHS];
  if (cspReportPath && cspReportPath.trim() !== '') paths.push(cspReportPath.trim());
  return paths;
}

/** Pfad ohne Query und ohne abschliessenden Slash - fuer stabile Vergleiche. */
function normalizePath(value: unknown): string {
  const raw = String(value ?? '');
  const withoutQuery = raw.split('?')[0];
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
  return trimmed;
}

/**
 * Wird diese Anfrage im Wartungszustand BLOCKIERT? Nur `/api/*`, und innerhalb
 * davon alles ausser den erlaubten Pfaden. Alles andere (SPA, Assets, der
 * statische Medienweg) wird weiter ausgeliefert.
 */
export function shouldBlockRequest(pathname: unknown, allowedPaths: readonly string[] = KILL_SWITCH_BASE_ALLOWED_PATHS): boolean {
  const path = normalizePath(pathname);
  if (!path.startsWith('/api/') && path !== '/api') return false;
  return !allowedPaths.some((allowed) => normalizePath(allowed) === path);
}

/** Antwortkoerper im Wartungszustand (additiv, keine Interna). */
export function killSwitchPayload(): {
  error: string;
  code: string;
  status: 'maintenance';
  retryAfterSeconds: number;
} {
  return {
    error: 'Wartung: audioMONASTRY nimmt derzeit keine neuen Auftraege an.',
    code: KILL_SWITCH_CODE,
    status: 'maintenance',
    retryAfterSeconds: KILL_SWITCH_RETRY_AFTER_SECONDS,
  };
}
