/**
 * audioMONASTRY · sinkRecovery (RT-AUDIT-P0-007)
 * ===============================================
 * Reine Entscheidungslogik (Main-Thread) für Fehler des V2-Live-Sinks:
 * Wann wird der Sink neu aufgebaut, wann wird nur gezählt, wann gibt die
 * Engine auf und zeigt „Audio-Engine gestört – bitte neu laden“?
 *
 *   - `processorerror`: der Prozessor ist tot → Neuaufbau.
 *   - `render-error`: der Prozessor lebt (Fehler wurde im Worklet gefangen).
 *     Einzelne Fehler werden nur gezählt und gemeldet. Erst wenn innerhalb von
 *     2 s mindestens 50 Fehler auflaufen (der Render scheitert dauerhaft),
 *     wird neu aufgebaut.
 *   - `message-error`: nur zählen/melden.
 *   - Höchstens 3 Neuaufbauten pro 60 s. Ein weiterer nötiger Neuaufbau
 *     schaltet in den Fehlerzustand `failed` (bleibt bis zum Neuladen).
 *
 * Ohne Timer, ohne Browser-APIs: die Zeit wird übergeben, damit die Drosselung
 * deterministisch testbar ist.
 */

export type V2SinkFaultKind = 'processorerror' | 'render-error' | 'message-error';

export interface V2SinkFaultInfo {
  kind: V2SinkFaultKind;
  message: string;
  /** render-error: kumulierte Fehlerzahl des Prozessors. */
  count?: number;
  /** message-error: Typ der Nachricht, deren Verarbeitung scheiterte. */
  messageType?: string;
}

/** `ignore` = nur zählen/melden, `rebuild` = Sink neu aufbauen, `give-up` = Fehlerzustand. */
export type SinkRecoveryDecision = 'ignore' | 'rebuild' | 'give-up';

/** Anzeige-Zustand für die UI. */
export type SinkRecoveryState = 'ok' | 'recovered' | 'failed';

export interface SinkRecoveryOptions {
  maxRebuilds?: number;
  rebuildWindowMs?: number;
  renderErrorThreshold?: number;
  renderErrorWindowMs?: number;
}

export const SINK_RECOVERY_DEFAULTS: Required<SinkRecoveryOptions> = {
  maxRebuilds: 3,
  rebuildWindowMs: 60_000,
  renderErrorThreshold: 50,
  renderErrorWindowMs: 2_000,
};

export interface SinkRecoveryStatus {
  state: SinkRecoveryState;
  rebuilds: number;
  lastRebuildAtMs: number | null;
  renderErrors: number;
  messageErrors: number;
  lastFault: V2SinkFaultInfo | null;
}

export class SinkRecoveryPolicy {
  private readonly opts: Required<SinkRecoveryOptions>;
  /** Zeitpunkte der Neuaufbauten im aktuellen Fenster. */
  private rebuildTimes: number[] = [];
  /** Render-Fehler-Zuwächse (Zeit, Anzahl) im aktuellen Fenster. */
  private renderDeltas: Array<{ at: number; errors: number }> = [];
  /** Letzter gemeldeter kumulierter Zähler des aktuellen Prozessors. */
  private lastRenderCount = 0;
  private failed = false;
  private totalRebuilds = 0;
  private lastRebuildAt: number | null = null;
  private renderErrorTotal = 0;
  private messageErrorTotal = 0;
  private lastFault: V2SinkFaultInfo | null = null;

  constructor(options: SinkRecoveryOptions = {}) {
    this.opts = { ...SINK_RECOVERY_DEFAULTS, ...options };
  }

  /** Bewertet einen Fehler. `nowMs` ist eine monotone Zeit in ms. */
  onFault(info: V2SinkFaultInfo, nowMs: number): SinkRecoveryDecision {
    this.lastFault = info;
    if (info.kind === 'message-error') {
      this.messageErrorTotal++;
      return 'ignore';
    }
    if (info.kind === 'render-error') {
      const count = typeof info.count === 'number' && Number.isFinite(info.count) ? info.count : this.lastRenderCount + 1;
      // Zähler kleiner als zuletzt → neuer Prozessor, Zählung beginnt neu.
      const delta = count >= this.lastRenderCount ? count - this.lastRenderCount : count;
      this.lastRenderCount = count;
      this.renderErrorTotal += delta;
      this.renderDeltas.push({ at: nowMs, errors: delta });
      const from = nowMs - this.opts.renderErrorWindowMs;
      this.renderDeltas = this.renderDeltas.filter((d) => d.at >= from);
      let inWindow = 0;
      for (const d of this.renderDeltas) inWindow += d.errors;
      if (inWindow < this.opts.renderErrorThreshold) return 'ignore';
      return this.requestRebuild(nowMs);
    }
    // processorerror: Prozessor tot.
    return this.requestRebuild(nowMs);
  }

  /** Neuaufbau nur innerhalb des Budgets (3 pro 60 s), sonst Fehlerzustand. */
  private requestRebuild(nowMs: number): SinkRecoveryDecision {
    if (this.failed) return 'ignore';
    const from = nowMs - this.opts.rebuildWindowMs;
    this.rebuildTimes = this.rebuildTimes.filter((t) => t > from);
    if (this.rebuildTimes.length >= this.opts.maxRebuilds) {
      this.failed = true;
      return 'give-up';
    }
    this.rebuildTimes.push(nowMs);
    this.totalRebuilds++;
    this.lastRebuildAt = nowMs;
    // Der neue Prozessor zählt wieder ab 0.
    this.lastRenderCount = 0;
    this.renderDeltas = [];
    return 'rebuild';
  }

  /** Neuaufbau ist gescheitert (z. B. connect() false) → Fehlerzustand. */
  markFailed(): void {
    this.failed = true;
  }

  /**
   * Anzeige-Zustand: `failed` dauerhaft, `recovered` für `recentMs` nach dem
   * letzten Neuaufbau, sonst `ok`.
   */
  status(nowMs: number, recentMs = 10_000): SinkRecoveryStatus {
    let state: SinkRecoveryState = 'ok';
    if (this.failed) state = 'failed';
    else if (this.lastRebuildAt !== null && nowMs - this.lastRebuildAt < recentMs) state = 'recovered';
    return {
      state,
      rebuilds: this.totalRebuilds,
      lastRebuildAtMs: this.lastRebuildAt,
      renderErrors: this.renderErrorTotal,
      messageErrors: this.messageErrorTotal,
      lastFault: this.lastFault,
    };
  }
}

export interface SinkRecoveryControllerDeps {
  /** Baut den Sink neu auf und gleicht den Zustand ab; `false` = gescheitert. */
  rebuild: () => Promise<boolean>;
  /** Monotone Zeit in ms (Default: performance.now bzw. Date.now). */
  now?: () => number;
  /** Diagnose-Ausgabe (Default: console.warn). */
  log?: (message: string, info?: V2SinkFaultInfo) => void;
  options?: SinkRecoveryOptions;
}

const defaultNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/**
 * Main-Thread-Ablauf um die Policy: nimmt `onFault` des V2LiveSink entgegen,
 * führt Neuaufbauten seriell aus (während eines Neuaufbaus eintreffende Fehler
 * des alten Knotens stoßen keinen zweiten an) und liefert den Anzeige-Zustand.
 */
export class SinkRecoveryController {
  readonly policy: SinkRecoveryPolicy;
  private readonly deps: SinkRecoveryControllerDeps;
  private readonly now: () => number;
  private rebuilding: Promise<boolean> | null = null;

  constructor(deps: SinkRecoveryControllerDeps) {
    this.deps = deps;
    this.now = deps.now ?? defaultNow;
    this.policy = new SinkRecoveryPolicy(deps.options);
  }

  /** Läuft gerade ein Neuaufbau? */
  get isRebuilding(): boolean {
    return this.rebuilding !== null;
  }

  /** Fehler bewerten und ggf. Neuaufbau starten (abwartbar über `whenIdle()`). */
  handleFault(info: V2SinkFaultInfo): SinkRecoveryDecision {
    if (this.rebuilding && info.kind !== 'message-error') return 'ignore';
    const decision = this.policy.onFault(info, this.now());
    if (decision === 'ignore') {
      // Render-Fehler kommen gedrosselt (1/s) – nur den ersten protokollieren.
      if (info.kind !== 'render-error' || info.count === 1) this.log(`[v2-sink] ${info.kind}: ${info.message}`, info);
      return decision;
    }
    if (decision === 'give-up') {
      this.log('[v2-sink] Audio-Engine gestört – Neuaufbau-Grenze erreicht, bitte neu laden.', info);
      return decision;
    }
    this.log(`[v2-sink] ${info.kind} → Audio-Engine wird neu aufgebaut.`, info);
    this.rebuilding = this.runRebuild();
    return decision;
  }

  /** Wartet, bis ein laufender Neuaufbau abgeschlossen ist (Tests/Diagnose). */
  async whenIdle(): Promise<void> {
    while (this.rebuilding) await this.rebuilding;
  }

  status(recentMs?: number): SinkRecoveryStatus {
    return this.policy.status(this.now(), recentMs);
  }

  private async runRebuild(): Promise<boolean> {
    let ok = false;
    try {
      ok = await this.deps.rebuild();
    } catch (e) {
      this.log(`[v2-sink] Neuaufbau fehlgeschlagen: ${String((e as Error)?.message ?? e)}`);
      ok = false;
    } finally {
      this.rebuilding = null;
    }
    if (!ok) this.policy.markFailed();
    return ok;
  }

  private log(message: string, info?: V2SinkFaultInfo): void {
    try {
      if (this.deps.log) this.deps.log(message, info);
      else console.warn(message, info ?? '');
    } catch { /* Logging darf nie stören */ }
  }
}
