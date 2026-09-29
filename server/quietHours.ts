/**
 * audioMONASTRY · Ruhe-Modus fuer Alarme (OPS-P2-002)
 * ================================================================================
 * Betreiber-Entscheidung vom 2026-09-23: **22–07 Uhr, kritische Alarme
 * ausgenommen.** Innerhalb des Fensters werden Meldungen gesammelt und beim
 * ersten Kontakt danach gebündelt zugestellt; alles ab `critical` geht sofort
 * durch.
 *
 * Warum das nicht nur ein Filter ist:
 * Ein Filter, der Meldungen wegwirft, ist ein Datenverlust. Deshalb gibt es
 * einen begrenzten Puffer, der die zurueckgehaltenen Alarme aufbewahrt und beim
 * naechsten Kontakt nach dem Fenster nachliefert. Geht der Puffer voll, wird das
 * GEZAEHLT und gemeldet - verschwiegene Alarme waeren schlimmer als laute.
 *
 * Grenzen (ehrlich):
 *   * Der Puffer liegt IM PROZESS. Ein Neustart verliert ihn. Fuer die
 *     Alarmierung nach einem Neustart ist der Alertmanager selbst zustaendig
 *     (`repeat_interval`, `group_wait`) - hier wird nur die Leitung in der Nacht
 *     still gehalten.
 *   * Kein eigener Scheduler: ausgeliefert wird beim naechsten Alarmkontakt
 *     nach dem Fenster. Ohne Kontakt gibt es auch nichts zu liefern.
 *
 * Die Logik ist rein (kein Express-Import) und damit ohne Server testbar.
 */

export interface QuietHoursConfig {
  /** Stunde, ab der Ruhe gilt (0-23), z. B. 22. */
  startHour: number;
  /** Stunde, ab der wieder zugestellt wird (0-23), z. B. 7. */
  endHour: number;
  /** Ruhe-Modus abgeschaltet (`ALERT_QUIET_HOURS_OFF=1`). */
  disabled: boolean;
}

/** Voreinstellung aus der Betreiber-Entscheidung. */
export const DEFAULT_QUIET_HOURS: QuietHoursConfig = { startHour: 22, endHour: 7, disabled: false };

/** Ab dieser Auspraegung wird NICHT zurueckgehalten. */
const CRITICAL_SEVERITIES = new Set(['critical', 'fatal', 'page']);

/** Obergrenze des Puffers - danach wird gezaehlt statt still verworfen. */
export const QUIET_HOURS_BUFFER_MAX = 100;

/**
 * Ruhe-Fenster aus der Umgebung lesen.
 * `ALERT_QUIET_HOURS="22-7"` | `ALERT_QUIET_HOURS_OFF=1`.
 * Ungueltige Angaben fallen auf die Voreinstellung zurueck (kein stiller Ausfall).
 */
export function quietHoursFromEnv(env: Record<string, string | undefined> = process.env): QuietHoursConfig {
  const off = ['1', 'true', 'yes', 'on'].includes(String(env.ALERT_QUIET_HOURS_OFF ?? '').trim().toLowerCase());
  const raw = String(env.ALERT_QUIET_HOURS ?? '').trim();
  if (raw === '') return { ...DEFAULT_QUIET_HOURS, disabled: off };
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(raw);
  if (!m) return { ...DEFAULT_QUIET_HOURS, disabled: off };
  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (startHour > 23 || endHour > 23) return { ...DEFAULT_QUIET_HOURS, disabled: off };
  return { startHour, endHour, disabled: off };
}

/**
 * Liegt `hour` im Ruhe-Fenster? Das Fenster darf ueber Mitternacht laufen
 * (22 -> 7). Ist Start gleich Ende, ist es als "kein Fenster" zu lesen - sonst
 * waere der Modus immer an und Alarme kaemen nie an.
 */
export function isQuietHour(hour: number, config: QuietHoursConfig = DEFAULT_QUIET_HOURS): boolean {
  if (config.disabled) return false;
  const h = ((Math.trunc(hour) % 24) + 24) % 24;
  const { startHour, endHour } = config;
  if (startHour === endHour) return false;
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour;
}

/** Ist dieser Alarm kritisch genug, um die Ruhe zu durchbrechen? */
export function isCriticalAlert(alert: unknown): boolean {
  const labels = (alert as { labels?: Record<string, unknown> })?.labels ?? {};
  const severity = String(labels.severity ?? '').trim().toLowerCase();
  if (CRITICAL_SEVERITIES.has(severity)) return true;
  // Manche Absender setzen statt `severity` ein `priority`-Feld.
  const priority = String((labels as Record<string, unknown>).priority ?? '').trim().toLowerCase();
  return CRITICAL_SEVERITIES.has(priority);
}

/** Ein zurueckgehaltener Alarm mit dem Zeitpunkt, an dem er eintraf. */
export interface HeldAlert {
  text: string;
  heldAtMs: number;
}

export interface QuietHoursPlan {
  /** Jetzt zustellen. */
  deliver: string[];
  /** Zurueckhalten (innerhalb der Ruhe und nicht kritisch). */
  hold: string[];
  /** true, wenn ueberhaupt ein Fenster aktiv ist (fuer Log/Kennzahl). */
  quiet: boolean;
}

/**
 * Verteilt formatierte Alarme auf "jetzt" und "spaeter".
 * `texts` und `alerts` laufen parallel (gleicher Index = gleicher Alarm).
 */
export function planDelivery(
  alerts: unknown[],
  texts: string[],
  nowMs: number,
  config: QuietHoursConfig = DEFAULT_QUIET_HOURS,
): QuietHoursPlan {
  const hour = new Date(nowMs).getUTCHours();
  const quiet = isQuietHour(hour, config);
  const deliver: string[] = [];
  const hold: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    if (!quiet || isCriticalAlert(alerts[i])) deliver.push(texts[i]);
    else hold.push(texts[i]);
  }
  return { deliver, hold, quiet };
}

/** Bündelt zurueckgehaltene Alarme zu EINER Meldung (mit Deckelung). */
export function summarizeHeld(held: HeldAlert[], maxItems = 10): string {
  if (held.length === 0) return '';
  const shown = held.slice(0, maxItems).map((h) => `- ${h.text}`);
  const rest = held.length - shown.length;
  return [
    `[RUHE-MODUS] ${held.length} Alarm(e) aus der Nacht, gebündelt:`,
    ...shown,
    ...(rest > 0 ? [`- ... und ${rest} weitere`] : []),
  ].join('\n');
}

/**
 * Begrenzter Puffer fuer zurueckgehaltene Alarme.
 * `push` meldet ausdruecklich, wie viele verworfen wurden - eine stille
 * Verwerfung waere der Fehler, den dieser Modus verhindern soll.
 */
export function createHeldBuffer(max = QUIET_HOURS_BUFFER_MAX) {
  const items: HeldAlert[] = [];
  let dropped = 0;
  return {
    push(text: string, nowMs: number): void {
      if (items.length >= max) {
        dropped += 1;
        return;
      }
      items.push({ text, heldAtMs: nowMs });
    },
    /** Alle zurueckgehaltenen entnehmen und den Puffer leeren. */
    drain(): HeldAlert[] {
      const out = items.splice(0, items.length);
      return out;
    },
    size(): number {
      return items.length;
    },
    droppedCount(): number {
      return dropped;
    },
  };
}

export type HeldBuffer = ReturnType<typeof createHeldBuffer>;
