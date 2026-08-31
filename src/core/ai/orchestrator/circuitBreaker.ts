/**
 * audioMONASTRY · AI Orchestrator – Circuit Breaker (Phase 3 Hardening)
 * =====================================================================
 * Schützt vor Kaskaden-Ausfällen: nach `failureThreshold` Fehlern öffnet der
 * Breaker, lehnt weitere Calls sofort ab (fail-fast) und erlaubt nach
 * `resetTimeoutMs` genau EINEN HALF_OPEN-Probe-Call (FA-P1-8).
 */
import { aiLogger } from './aiLogger';

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export class CircuitBreaker {
  private state: BreakerState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(private name: string, options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? Number(process.env.AI_CB_FAILURE_THRESHOLD ?? 5);
    this.resetTimeoutMs = options.resetTimeoutMs ?? Number(process.env.AI_CB_RESET_MS ?? 30_000);
  }

  /** Reiner Getter – keine Zustandsmutation (FA-P1-8). */
  getState(): BreakerState {
    return this.state;
  }

  private tryTransitionToHalfOpen(): boolean {
    if (this.state !== 'OPEN') return false;
    if (Date.now() - this.openedAt < this.resetTimeoutMs) return false;
    this.state = 'HALF_OPEN';
    this.probeInFlight = false;
    aiLogger.info('circuit breaker half-open', { breaker: this.name });
    return true;
  }

  /** Führt `fn` aus; HALF_OPEN erlaubt genau einen Probe-Call (kein Thundering Herd). */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN' && !this.tryTransitionToHalfOpen()) {
      throw new Error(`circuit breaker open: ${this.name}`);
    }
    if (this.state === 'HALF_OPEN') {
      if (this.probeInFlight) throw new Error(`circuit breaker half-open probe busy: ${this.name}`);
      this.probeInFlight = true;
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    } finally {
      if (this.state !== 'HALF_OPEN') this.probeInFlight = false;
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
    this.probeInFlight = false;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.probeInFlight = false;
      aiLogger.warn('circuit breaker open', { breaker: this.name, failures: this.failures });
    }
  }
}
