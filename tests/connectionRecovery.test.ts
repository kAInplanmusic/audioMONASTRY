import { describe, expect, it } from 'vitest';
import {
  createRecoveryState,
  isConnectionHealthy,
  nextRecoveryDecision,
  RECOVERY_DEFAULTS,
  type IceConnectionStateLike,
  type PeerConnectionStateLike,
} from '../src/core/transport/connectionRecovery';

// ---------------------------------------------------------------------------
// COLLAB-P0-003: Verbindungs-Recovery. Geprüft werden die Übergänge:
// gesund → Reset, Ausfall → ICE-Restart, danach Reconnect mit Backoff,
// Karenz bei „disconnected", Obergrenze → aufgeben.
// ---------------------------------------------------------------------------

const T0 = 1_000_000;
const input = (ice: IceConnectionStateLike, connection: PeerConnectionStateLike, over: Record<string, unknown> = {}) => ({
  ice,
  connection,
  now: T0,
  ...over,
});

describe('isConnectionHealthy', () => {
  it('erkennt connected/completed in beiden Zuständen', () => {
    expect(isConnectionHealthy('connected', 'unknown')).toBe(true);
    expect(isConnectionHealthy('completed', 'unknown')).toBe(true);
    expect(isConnectionHealthy('new', 'connected')).toBe(true);
    expect(isConnectionHealthy('failed', 'failed')).toBe(false);
  });
});

describe('nextRecoveryDecision', () => {
  it('setzt bei gesunder Verbindung den Zustand zurück', () => {
    const busy = { attempts: 2, lastAttemptAt: T0 - 500, phase: 'recovering' as const };
    const d = nextRecoveryDecision(busy, input('connected', 'connected'));
    expect(d.action).toBe('none');
    expect(d.state).toEqual(createRecoveryState());
  });

  it('startet beim ersten Ausfall nur einen ICE-Restart, danach Reconnect mit Backoff', () => {
    let state = createRecoveryState();
    const first = nextRecoveryDecision(state, input('failed', 'failed'));
    expect(first.action).toBe('restart-ice');
    expect(first.delayMs).toBe(RECOVERY_DEFAULTS.baseDelayMs);
    state = first.state;

    const second = nextRecoveryDecision(state, input('failed', 'failed', { now: T0 + 1_000 }));
    expect(second.action).toBe('reconnect');
    expect(second.delayMs).toBe(RECOVERY_DEFAULTS.baseDelayMs * 2);
    state = second.state;

    const third = nextRecoveryDecision(state, input('failed', 'failed', { now: T0 + 3_000 }));
    expect(third.action).toBe('reconnect');
    expect(third.delayMs).toBe(RECOVERY_DEFAULTS.baseDelayMs * 4);
    state = third.state;

    // maxAttempts erreicht → aufgeben (kein Endlos-Reconnect).
    const fourth = nextRecoveryDecision(state, input('failed', 'failed', { now: T0 + 7_000 }));
    expect(fourth.action).toBe('gave-up');
    expect(fourth.state.phase).toBe('failed');
    // Und bleibt aufgegeben, statt neu zu zählen.
    expect(nextRecoveryDecision(fourth.state, input('failed', 'failed')).action).toBe('gave-up');
  });

  it('wartet bei „disconnected" die Karenz ab, statt sofort zu reagieren', () => {
    const state = createRecoveryState();
    const waiting = nextRecoveryDecision(state, input('disconnected', 'disconnected', { disconnectedForMs: 500 }));
    expect(waiting.action).toBe('wait');
    expect(waiting.delayMs).toBe(RECOVERY_DEFAULTS.disconnectGraceMs - 500);

    // Karenz überschritten → wie Ausfall behandeln (erster Versuch = ICE-Restart).
    const afterGrace = nextRecoveryDecision(state, input('disconnected', 'disconnected', { disconnectedForMs: RECOVERY_DEFAULTS.disconnectGraceMs + 10 }));
    expect(afterGrace.action).toBe('restart-ice');
  });

  it('greift während Aufbau/„closed" nicht ein', () => {
    const state = createRecoveryState();
    expect(nextRecoveryDecision(state, input('checking', 'connecting')).action).toBe('none');
    expect(nextRecoveryDecision(state, input('new', 'new')).action).toBe('none');
    expect(nextRecoveryDecision(state, input('closed', 'closed')).action).toBe('none');
  });

  it('respektiert eine eigene Policy (Backoff-Deckel, kein ICE-Restart)', () => {
    const policy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 2_500, disconnectGraceMs: 0, restartIceOnFirstFailure: false };
    const first = nextRecoveryDecision(createRecoveryState(), input('failed', 'failed'), policy);
    expect(first.action).toBe('reconnect');
    const second = nextRecoveryDecision(first.state, input('failed', 'failed', { now: T0 + 1 }), policy);
    expect(second.action).toBe('reconnect');
    expect(second.delayMs).toBe(2_000);
    const third = nextRecoveryDecision(second.state, input('failed', 'failed', { now: T0 + 2 }), policy);
    expect(third.delayMs).toBe(2_500); // gedeckelt
  });
});
