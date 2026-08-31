/**
 * audioMONASTRY · AI Orchestrator – Circuit Breaker (Phase 3 Hardening)
 * =====================================================================
 * Schützt vor Kaskaden-Ausfällen: nach `failureThreshold` Fehlern öffnet der
 * Breaker, lehnt weitere Calls sofort ab (fail-fast) und erlaubt nach
 * `resetTimeoutMs` einen HALF_OPEN-Probe-Call.
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
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(private name: string, options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? Number(process.env.AI_CB_FAILURE_THRESHOLD ?? 5);
    this.resetTimeoutMs = options.resetTimeoutMs ?? Number(process.env.AI_CB_RESET_MS ?? 30_000);
  }

  getState(): BreakerState {
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = 'HALF_OPEN';
      aiLogger.info('circuit breaker half-open', { breaker: this.name });
    }
    return this.state;
  }

  /** Führt `fn` aus, wenn der Breaker geschlossen/halb-offen ist. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === 'OPEN') {
      throw new Error(`circuit breaker open: ${this.name}`);
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      aiLogger.warn('circuit breaker open', { breaker: this.name, failures: this.failures });
    }
  }
}
