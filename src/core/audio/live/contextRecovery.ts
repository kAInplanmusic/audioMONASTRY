/**
 * audioMONASTRY · Recovery-Entscheidung des AudioContext-Statushandlers
 * =====================================================================
 * Der Context-Handler in `src/utils/audioEngine.ts` war bis 2026-10-16 eine
 * reine if/else-Kette an einer Stelle, die kein Unit-Test erreichen kann: sie
 * wird in `init()` registriert, und `init()` braucht einen echten Tone-Context.
 * Genau dort lagen zwei Fehler, die niemandem auffielen:
 *
 *   1. `interrupted` (iOS: Anruf, Siri, Hintergrund-App) wurde gar nicht
 *      behandelt — der Worklet-Transport lief nach der Unterbrechung stumm
 *      weiter, statt anzuhalten und spaeter wieder aufzusetzen.
 *   2. Der Wiedergabewunsch wurde mit `= this.isPlaying` bei JEDEM Wechsel
 *      gesetzt. Ein zweiter Wechsel innerhalb der Unterbrechung
 *      (`interrupted` -> `suspended`) setzte ihn damit auf `false` — die
 *      Wiederaufnahme war verloren, obwohl der Nutzer nie gestoppt hat.
 *
 * Die Entscheidung ist deshalb hier als reine Funktion herausgezogen: kein
 * Netz, kein Timer, kein Context — direkt testbar (`tests/contextRecovery.test.ts`).
 * Der Effekt (Transport anhalten/starten, Anker erneuern) bleibt im Engine-Pfad.
 */

/** Was der Statushandler bei diesem Wechsel tun soll. */
export type ContextRecoveryAction =
  /** Unterbrechung: Transport anhalten und den Wiedergabewunsch sichern. */
  | 'interrupt'
  /** Unterbrechung vorbei: Transport neu starten, Zeitachse erneuern. */
  | 'resume'
  /** Nichts tun (Wechsel ohne Bedeutung fuer den Transport). */
  | 'none';

/**
 * Unterbrechungszustaende des AudioContext.
 *
 * `suspended` = Autoplay-Gate, OS-Sleep, Geraetewechsel.
 * `interrupted` = iOS-Sonderfall (Anruf, Siri, Hintergrund) — derselbe
 * Handlungsbedarf, aber ein EIGENER Zustand: er kommt in jeder
 * iOS-Unterbrechung und ist der Grund, warum `suspended` allein nicht reicht.
 */
export function isInterruptionState(state: string | undefined): boolean {
  return state === 'suspended' || state === 'interrupted';
}

/**
 * Entscheidet den Handlungsbedarf eines Context-Statuswechsels.
 *
 * @param state                 der neue Context-Zustand (`ctx.state`)
 * @param isPlaying             laeuft der Transport gerade?
 * @param wasPlayingBeforeSuspend der gesicherte Wiedergabewunsch
 *
 * Wichtig: `interrupt` wird NUR zurueckgegeben, wenn gerade wirklich gespielt
 * wird. Im Unterbrechungszustand selbst bleibt der bereits gesicherte
 * Wiedergabewunsch damit unberuehrt — ein wiederholter Wechsel
 * (`interrupted` -> `suspended` -> `interrupted`) kann ihn nicht ueberschreiben.
 */
export function decideContextRecovery(
  state: string | undefined,
  isPlaying: boolean,
  wasPlayingBeforeSuspend: boolean,
): ContextRecoveryAction {
  if (isInterruptionState(state)) {
    return isPlaying ? 'interrupt' : 'none';
  }
  if (state === 'running' && wasPlayingBeforeSuspend) return 'resume';
  return 'none';
}

/**
 * Der Wiedergabewunsch nach einem ausdruecklichen Nutzer-Stop.
 *
 * Ein Stop ist ein Widerruf: kommt der Context danach aus einer Unterbrechung
 * zurueck (`running`), darf der Transport nicht von selbst wieder anlaufen.
 * Ohne diese Regel startet der Auto-Resume die Wiedergabe gegen den Willen des
 * Nutzers neu.
 */
export const PLAY_INTENT_AFTER_USER_STOP = false;
