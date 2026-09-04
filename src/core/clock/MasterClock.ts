/**
 * audioMONASTRY · MONASTRYmasterclock (NEW-MONK-8, serverloser Kern)
 * ==================================================================
 * Unsichtbares Systemmodul – eine singuläre Timing-Quelle für die App.
 * Verwaltet BPM/Start/Stop, Latenz-Budget (Lookahead 8–15 ms) und einen
 * Dropout-/Fehler-Watchdog mit Auto-Recovery. Diagnose läuft über
 * perfMONK (Metriken via Callback).
 *
 * Der Worklet-/Tone-Transport wird in `audioEngine` angebunden; diese
 * Klasse ist die reine, testbare Steuerlogik.
 */

export interface MasterClockState {
  bpm: number;
  playing: boolean;
  lookaheadMs: number;
  estimatedLatencyMs: number;
  dropouts: number;
  recovered: number;
  lastError: string | null;
}

export interface MasterClockOptions {
  minLookaheadMs?: number;
  maxLookaheadMs?: number;
  maxDropoutRate?: number; // Dropouts pro 10 s, bevor Recovery eingreift
}

const DEFAULTS = {
  minLookaheadMs: 8,
  maxLookaheadMs: 15,
  maxDropoutRate: 2,
} as const;

export class MasterClock {
  private state: MasterClockState = {
    bpm: 120,
    playing: false,
    lookaheadMs: 10,
    estimatedLatencyMs: 10,
    dropouts: 0,
    recovered: 0,
    lastError: null,
  };
  private recentDropouts: number[] = [];
  private readonly options: Required<MasterClockOptions>;

  constructor(options: MasterClockOptions = {}, private onMetrics?: (s: MasterClockState) => void) {
    this.options = {
      minLookaheadMs: options.minLookaheadMs ?? DEFAULTS.minLookaheadMs,
      maxLookaheadMs: options.maxLookaheadMs ?? DEFAULTS.maxLookaheadMs,
      maxDropoutRate: options.maxDropoutRate ?? DEFAULTS.maxDropoutRate,
    };
  }

  get snapshot(): MasterClockState {
    return { ...this.state };
  }

  setBpm(bpm: number): void {
    if (!Number.isFinite(bpm)) return;
    this.state.bpm = Math.max(30, Math.min(300, bpm));
    this.emit();
  }

  start(): void {
    this.state.playing = true;
    this.state.lastError = null;
    this.emit();
  }

  stop(): void {
    this.state.playing = false;
    this.emit();
  }

  /** Latenz-Messwert übernehmen → Lookahead wird im Budget adaptiert. */
  reportLatency(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) return;
    this.state.estimatedLatencyMs = latencyMs;
    this.state.lookaheadMs = Math.max(
      this.options.minLookaheadMs,
      Math.min(this.options.maxLookaheadMs, Math.round(latencyMs + 6)),
    );
    this.emit();
  }

  /** Dropout/Underrun melden → Watchdog zählt und löst ggf. Recovery aus. */
  reportDropout(now = Date.now()): boolean {
    this.state.dropouts += 1;
    this.recentDropouts = this.recentDropouts.filter((t) => now - t < 10_000);
    this.recentDropouts.push(now);

    let recovered = false;
    if (this.recentDropouts.length > this.options.maxDropoutRate) {
      // Auto-Recovery: Lookahead eine Stufe erhöhen, Zähler-Reset des Fensters.
      this.state.lookaheadMs = Math.min(this.options.maxLookaheadMs, this.state.lookaheadMs + 2);
      this.state.recovered += 1;
      this.state.lastError = `dropout-burst (${this.recentDropouts.length}/10s) → lookahead ${this.state.lookaheadMs} ms`;
      this.recentDropouts = [];
      recovered = true;
    }
    this.emit();
    return recovered;
  }

  private emit(): void {
    this.onMetrics?.(this.snapshot);
  }
}
