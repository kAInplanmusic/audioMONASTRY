/** Operator Round5: session cap is fixed; unknown telemetry fails closed. */
export const SESSION_CAP_EUR = 50;
export const COST_POLL_MS = 30000;
export const RAW_FLUSH_MS = 10000;
export const NETWORK_WINDOW_MS = 30000;
export interface CostSample {
  sessionId: string; currency: 'EUR'; totalEur: number; observedAt: number;
  source: 'provider-api-actual-spend' | 'simulation'; scopeComplete: boolean;
}
export interface RateBound {
  rEchtEurPerHour: number; rGuardEurPerHour: number; safetyFactor: number;
}
export class LiveGuard {
  private stopping: Promise<void> | null = null;
  private lastCost: number | null = null;
  private lastElapsedMs = -1;
  private network = new Map<string, { at: number; concealed: number; received: number }[]>();
  reason: string | null = null;
  constructor(private options: {
    sessionId: string; simulation?: boolean;
    record: (event: unknown) => void;
    flush: () => Promise<void> | void;
    stop: (reason: string) => Promise<void> | void;
  }) {}
  get stopped() { return this.reason !== null; }
  halt(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.reason = reason;
    // Promise.resolve schedules the work after the latch has been installed.
    this.stopping = Promise.resolve().then(async () => {
      this.options.record({ type: 'guard-stop', reason, at: new Date().toISOString() });
      try { await this.options.flush(); }
      finally { await this.options.stop(reason); } // Stop even on disk failure, report the failure.
    });
    return this.stopping;
  }
  async cost(sample: CostSample | null, now: number): Promise<void> {
    if (this.stopped) return;
    this.options.record({ type: 'cost', sample, at: now });
    if (!sample || sample.sessionId !== this.options.sessionId || sample.currency !== 'EUR'
      || !sample.scopeComplete || !Number.isFinite(sample.totalEur) || sample.totalEur < 0
      || !Number.isFinite(sample.observedAt) || now - sample.observedAt > COST_POLL_MS || sample.observedAt > now + 1000
      || (sample.source !== 'provider-api-actual-spend' && !(this.options.simulation && sample.source === 'simulation'))
      || (this.lastCost !== null && sample.totalEur < this.lastCost)) {
      await this.halt('cost-unavailable-or-invalid'); return;
    }
    this.lastCost = sample.totalEur;
    if (sample.totalEur >= SESSION_CAP_EUR) await this.halt('session-cap-50-eur');
  }
  /** Explicit operator-approved tariff bound, never masquerading as actual spend. */
  async budget(sample: CostSample | null, now: number, elapsedMs: number, bound?: RateBound): Promise<void> {
    if (this.stopped) return;
    if (!bound) { await this.cost(sample, now); return; }
    if (![elapsedMs, bound.rEchtEurPerHour, bound.rGuardEurPerHour].every(Number.isFinite)
      || elapsedMs < 0 || elapsedMs < this.lastElapsedMs || bound.rEchtEurPerHour <= 0
      || bound.safetyFactor !== 1.5 || Math.abs(bound.rGuardEurPerHour - bound.rEchtEurPerHour * 1.5) > 1e-10) {
      await this.halt('invalid-rate-upper-bound'); return;
    }
    this.lastElapsedMs = elapsedMs;
    const upperEur = elapsedMs / 3600000 * bound.rGuardEurPerHour;
    this.options.record({ type: 'cost-upper-bound', label: 'Obergrenze (R_guard), keine Ist-Kosten',
      elapsedMs, rEchtEurPerHour: bound.rEchtEurPerHour, rGuardEurPerHour: bound.rGuardEurPerHour,
      upperEur, capEur: SESSION_CAP_EUR, actualCostsAvailable: sample !== null,
      decisionSource: sample !== null ? 'actual-cost-contract' : 'rate-upper-bound' });
    // A supplied actual sample must still pass all existing validation. Bad data
    // never silently falls back to an estimate. Valid actual costs take priority.
    if (sample !== null) { await this.cost(sample, now); return; }
    if (upperEur >= SESSION_CAP_EUR) await this.halt('session-cap-50-eur-upper-bound');
  }
  async rtp(key: string, at: number, concealed: number | null, received: number | null): Promise<void> {
    if (this.stopped) return;
    if (concealed === null || received === null) return; // Unknown is not a zero.
    if (![at, concealed, received].every(Number.isFinite) || concealed < 0 || received < 0 || concealed > received) {
      await this.halt('invalid-network-counters'); return;
    }
    const window = (this.network.get(key) ?? []).filter(row => row.at > at - NETWORK_WINDOW_MS);
    window.push({ at, concealed, received }); this.network.set(key, window);
    const total = window.reduce((sum, row) => sum + row.received, 0);
    const ratio = total > 0 ? window.reduce((sum, row) => sum + row.concealed, 0) / total : null;
    this.options.record({ type: 'network-window', key, at, windowMs: NETWORK_WINDOW_MS, concealmentRatio: ratio,
      metric: 'inbound RTP concealedSamples / totalSamplesReceived interval deltas; per receiver/peer, rolling 30s; network only',
      glitchRate: null, glitchRateStatus: 'nicht gemessen: keine Blockzähler' });
    if (ratio !== null && ratio > .20) await this.halt('network-concealment-over-20-percent');
  }
  async handover(outageSeconds: number | null): Promise<void> {
    if (this.stopped || outageSeconds === null) return;
    this.options.record({ type: 'handover', outageSeconds, method: 'receiver RTP delivery; not physical PA latency' });
    if (!Number.isFinite(outageSeconds) || outageSeconds < 0) await this.halt('invalid-handover');
    else if (outageSeconds > 5) await this.halt('handover-over-5-seconds');
  }
}

/** Tracks owner changes only after real audio delivery was observed at an output.
 * RTP reception is a network delivery probe, not a calibrated audio/PA measurement.
 */
export class HandoverObserver {
  private owner: string | null = null;
  private heard = false;
  private pending: { from: string; to: string; at: number } | null = null;
  observe(owner: string, deliveredFromOwner: boolean, at: number) {
    if (this.owner !== null && owner !== this.owner && (this.heard || this.pending)) {
      this.pending ??= { from: this.owner, to: owner, at };
      this.pending.to = owner; // Repeated changes must not reset the outage clock.
      this.heard = false;
    }
    this.owner = owner;
    if (deliveredFromOwner) this.heard = true;
    if (!this.pending) return null;
    const result = { ...this.pending, outageSeconds: (at - this.pending.at) / 1000, complete: deliveredFromOwner };
    if (deliveredFromOwner) this.pending = null;
    return result;
  }
}
