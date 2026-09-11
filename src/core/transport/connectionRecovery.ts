/**
 * audioMONASTRY · Verbindungs-Recovery (COLLAB-P0-003)
 * ====================================================
 * Reine Zustandsmaschine für ICE-/PeerConnection-Ausfälle. Vorher reagierte der
 * Client gar nicht auf `iceConnectionState`/`connectionState`; ein Ausfall
 * konnte doppelte PeerConnections erzeugen. Diese Maschine entscheidet
 * deterministisch, was zu tun ist – mit Backoff und Obergrenze:
 *
 *   connected/completed        → Zustand zurücksetzen (kein Eingriff)
 *   failed                     → 1. Versuch: ICE-Restart, danach Reconnect mit
 *                                Exponential-Backoff; nach `maxAttempts`: aufgeben
 *   disconnected (mit Karenz)  → warten, erst nach `disconnectGraceMs` handeln
 *   closed                     → nichts (bewusst geschlossen)
 *
 * `now` wird injiziert → testbar ohne Timer.
 */

export type IceConnectionStateLike =
  | 'new' | 'checking' | 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed';

export type PeerConnectionStateLike =
  | 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed' | 'unknown';

export interface RecoveryState {
  /** Bisherige Wiederherstellungsversuche. */
  attempts: number;
  /** Zeitpunkt des letzten Versuchs (ms). */
  lastAttemptAt: number;
  phase: 'idle' | 'recovering' | 'failed';
}

export interface RecoveryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Karenz, bevor `disconnected` als Ausfall gilt (ICE heilt oft selbst). */
  disconnectGraceMs: number;
  /** Erster Ausfall: nur ICE-Restart statt kompletter Neuaufbau. */
  restartIceOnFirstFailure: boolean;
}

export const RECOVERY_DEFAULTS: RecoveryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  disconnectGraceMs: 3_000,
  restartIceOnFirstFailure: true,
};

export type RecoveryAction = 'none' | 'wait' | 'restart-ice' | 'reconnect' | 'gave-up';

export interface RecoveryDecision {
  state: RecoveryState;
  action: RecoveryAction;
  /** Wartezeit vor der Aktion (0 = sofort). */
  delayMs: number;
  reason: string;
}

export interface RecoveryInput {
  ice: IceConnectionStateLike;
  connection: PeerConnectionStateLike;
  now: number;
  /** Wie lange `disconnected` schon beobachtet wird (ms); 0 wenn unbekannt. */
  disconnectedForMs?: number;
}

export function createRecoveryState(): RecoveryState {
  return { attempts: 0, lastAttemptAt: 0, phase: 'idle' };
}

export function isConnectionHealthy(ice: IceConnectionStateLike, connection: PeerConnectionStateLike): boolean {
  return ice === 'connected' || ice === 'completed' || connection === 'connected';
}

function backoffDelay(attempts: number, policy: RecoveryPolicy): number {
  const raw = policy.baseDelayMs * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(raw)));
}

/**
 * Nächste Entscheidung. Der Aufrufer darf `state` danach übernehmen und die
 * Aktion ausführen; bei `none`/`wait` bleibt der Zustand unverändert bzw. wird
 * nur der gesunde Fall zurückgesetzt.
 */
export function nextRecoveryDecision(
  state: RecoveryState,
  input: RecoveryInput,
  policy: RecoveryPolicy = RECOVERY_DEFAULTS,
): RecoveryDecision {
  const p = { ...RECOVERY_DEFAULTS, ...policy };

  if (isConnectionHealthy(input.ice, input.connection)) {
    return {
      state: createRecoveryState(),
      action: 'none',
      delayMs: 0,
      reason: 'healthy',
    };
  }

  if (input.ice === 'closed' || input.connection === 'closed') {
    return { state, action: 'none', delayMs: 0, reason: 'closed' };
  }

  if (input.ice === 'disconnected' || input.connection === 'disconnected') {
    const waited = Number.isFinite(input.disconnectedForMs) ? Math.max(0, input.disconnectedForMs as number) : 0;
    if (waited < p.disconnectGraceMs) {
      return {
        state,
        action: 'wait',
        delayMs: p.disconnectGraceMs - waited,
        reason: 'disconnected-grace',
      };
    }
    // Karenz überschritten → wie ein Ausfall behandeln.
  } else if (input.ice !== 'failed' && input.connection !== 'failed') {
    // new/checking/connecting … → abwarten, kein Eingriff.
    return { state, action: 'none', delayMs: 0, reason: 'in-progress' };
  }

  if (state.phase === 'failed') {
    return { state, action: 'gave-up', delayMs: 0, reason: 'already-failed' };
  }

  const attempts = state.attempts + 1;
  if (attempts > p.maxAttempts) {
    return {
      state: { attempts, lastAttemptAt: input.now, phase: 'failed' },
      action: 'gave-up',
      delayMs: 0,
      reason: `max-attempts(${p.maxAttempts})`,
    };
  }

  const useIceRestart = attempts === 1 && p.restartIceOnFirstFailure;
  return {
    state: { attempts, lastAttemptAt: input.now, phase: 'recovering' },
    action: useIceRestart ? 'restart-ice' : 'reconnect',
    delayMs: backoffDelay(attempts, p),
    reason: useIceRestart ? 'first-failure-ice-restart' : `attempt-${attempts}`,
  };
}
