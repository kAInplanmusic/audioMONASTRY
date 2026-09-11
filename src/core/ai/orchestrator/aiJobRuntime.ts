/**
 * audioMONASTRY · AI-Job-Runtime (AI-P1-002)
 * ==========================================
 * Der Orchestrator rief Provider bisher direkt auf: kein Executor, kein
 * Per-Job-Timeout, keine Abbruchmöglichkeit – ein hängender Request blockierte
 * den Aufrufer (und potenziell den UI-/Render-Thread) bis zum Stale-Cleanup.
 *
 * Dieser Kern kapselt AI-Jobs in einer Warteschlange mit:
 *
 *   * **Bounded Concurrency** – nie mehr als `maxConcurrent` gleichzeitig.
 *   * **Nicht-blockierendem Submit** – `submit()` führt NIE Job-Code synchron
 *     aus; gestartet wird über einen injizierbaren Scheduler (Default:
 *     `setTimeout(…, 0)`), damit der Event-Loop/Render-Thread weiterläuft.
 *   * **Timeout je Job** – nach `timeoutMs` wird das `AbortSignal` ausgelöst
 *     und der Job als `timeout` beendet (auch wenn der Provider weiterläuft).
 *   * **Cancellation** – wartende Jobs werden nie gestartet, laufende bekommen
 *     `abort()`; der Slot wird sofort frei.
 *   * **Injizierbarem Executor** – ein Adapter (z. B. Web-Worker über
 *     `utils/workerFactory.ts`) kann CPU-Arbeit aus dem Main-Thread auslagern;
 *     der Kern bleibt frei von Plattform-APIs.
 *   * **Metriken** – queued/running/completed/failed/cancelled/timedOut.
 *
 * `now`/Timer sind injizierbar → deterministisch testbar, ohne echte Zeit.
 */

export type AiRuntimeJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export class AiJobTimeoutError extends Error {
  readonly code = 'AI_JOB_TIMEOUT';
  constructor(message: string) {
    super(message);
    this.name = 'AiJobTimeoutError';
  }
}

export class AiJobCancelledError extends Error {
  readonly code = 'AI_JOB_CANCELLED';
  constructor(message = 'AI-Job abgebrochen') {
    super(message);
    this.name = 'AiJobCancelledError';
  }
}

export interface AiRuntimeJobResult<T> {
  id: string;
  status: AiRuntimeJobStatus;
  value?: T;
  error?: Error;
  /** Wartezeit in der Queue (ms). */
  waitedMs: number;
  /** Ausführungszeit (ms). */
  ranMs: number;
}

export interface AiRuntimeJobHandle<T> {
  id: string;
  /** Löst IMMER auf (Status statt Rejection) – kein unbehandelter Fehlerpfad. */
  promise: Promise<AiRuntimeJobResult<T>>;
  cancel(reason?: string): boolean;
}

export interface AiRuntimeJobOptions {
  /** Eindeutige ID (Default: generiert). */
  id?: string;
  /** Timeout in ms (0 = kein Timeout). Default: `defaultTimeoutMs`. */
  timeoutMs?: number;
  /** Höher = früher (stabile FIFO-Reihenfolge innerhalb gleicher Priorität). */
  priority?: number;
  label?: string;
}

export interface AiRuntimeTimers {
  /** Startet eine Aufgabe im nächsten Tick (nie synchron ausführen). */
  schedule(fn: () => void): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
}

export type AiJobExecutor = <T>(
  run: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timers: AiRuntimeTimers,
) => Promise<T>;

export interface AiJobRuntimeOptions {
  maxConcurrent?: number;
  defaultTimeoutMs?: number;
  timers?: Partial<AiRuntimeTimers>;
  /** Auslagerung/Instrumentierung; Default: In-Process mit Timeout. */
  executor?: AiJobExecutor;
}

export interface AiJobRuntimeStats {
  queued: number;
  running: number;
  maxConcurrent: number;
  submitted: number;
  completed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  /** Höchste je beobachtete Gleichzeitigkeit (Beweis der Concurrency-Grenze). */
  peakRunning: number;
}

interface RuntimeEntry<T> {
  id: string;
  run: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
  priority: number;
  label?: string;
  enqueuedAt: number;
  startedAt: number;
  settled: boolean;
  started: boolean;
  cancelled: boolean;
  controller: AbortController;
  resolve: (result: AiRuntimeJobResult<T>) => void;
}

const defaultTimers: AiRuntimeTimers = {
  schedule: (fn) => { setTimeout(fn, 0); },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
  now: () => Date.now(),
};

/** In-Process-Executor: begrenzt die Laufzeit über einen Timer + AbortSignal. */
const defaultExecutor: AiJobExecutor = (run, signal, timeoutMs, timers) => {
  if (!(timeoutMs > 0)) return run(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    const handle = timers.setTimer(() => {
      if (done) return;
      done = true;
      reject(new AiJobTimeoutError(`AI-Job nach ${timeoutMs} ms abgebrochen`));
    }, timeoutMs);
    run(signal).then(
      (value) => {
        if (done) return;
        done = true;
        timers.clearTimer(handle);
        resolve(value);
      },
      (error) => {
        if (done) return;
        done = true;
        timers.clearTimer(handle);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
};

export class AiJobRuntime {
  private readonly maxConcurrent: number;
  private readonly defaultTimeoutMs: number;
  private readonly timers: AiRuntimeTimers;
  private readonly executor: AiJobExecutor;
  private readonly queue: RuntimeEntry<unknown>[] = [];
  private readonly active = new Set<RuntimeEntry<unknown>>();
  private readonly entries = new Map<string, RuntimeEntry<unknown>>();
  private idleResolvers: Array<() => void> = [];
  private counter = 0;
  private stats = { submitted: 0, completed: 0, failed: 0, cancelled: 0, timedOut: 0, peakRunning: 0 };

  constructor(options: AiJobRuntimeOptions = {}) {
    this.maxConcurrent = Number.isFinite(options.maxConcurrent) && (options.maxConcurrent as number) > 0
      ? Math.floor(options.maxConcurrent as number)
      : 4;
    this.defaultTimeoutMs = Number.isFinite(options.defaultTimeoutMs) && (options.defaultTimeoutMs as number) >= 0
      ? Math.floor(options.defaultTimeoutMs as number)
      : 120_000;
    this.timers = { ...defaultTimers, ...(options.timers ?? {}) };
    this.executor = options.executor ?? defaultExecutor;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get runningCount(): number {
    return this.active.size;
  }

  snapshot(): AiJobRuntimeStats {
    return {
      queued: this.queue.length,
      running: this.active.size,
      maxConcurrent: this.maxConcurrent,
      peakRunning: this.stats.peakRunning,
      ...this.stats,
    };
  }

  /**
   * Reiht einen Job ein und gibt sofort ein Handle zurück. Der Job-Code läuft
   * nie synchron in `submit()` – das ist die Isolationsgarantie für den
   * Audio-/Render-Thread.
   */
  submit<T>(run: (signal: AbortSignal) => Promise<T>, options: AiRuntimeJobOptions = {}): AiRuntimeJobHandle<T> {
    if (typeof run !== 'function') throw new Error('AiJobRuntime.submit braucht eine run-Funktion');
    this.counter += 1;
    const id = options.id?.trim() || `ai-job-${this.counter}`;
    if (this.entries.has(id)) throw new Error(`AI-Job-ID bereits vergeben: ${id}`);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.floor(options.timeoutMs as number)) : this.defaultTimeoutMs;
    let resolveFn!: (result: AiRuntimeJobResult<T>) => void;
    const promise = new Promise<AiRuntimeJobResult<T>>((resolve) => { resolveFn = resolve; });
    const entry: RuntimeEntry<T> = {
      id,
      run,
      timeoutMs,
      priority: Number.isFinite(options.priority) ? (options.priority as number) : 0,
      label: options.label,
      enqueuedAt: this.timers.now(),
      startedAt: 0,
      settled: false,
      started: false,
      cancelled: false,
      controller: new AbortController(),
      resolve: resolveFn,
    };
    this.entries.set(id, entry as RuntimeEntry<unknown>);
    this.queue.push(entry as RuntimeEntry<unknown>);
    // Stabile Prioritätsordnung (höhere priority zuerst, sonst FIFO).
    this.queue.sort((a, b) => b.priority - a.priority);
    this.stats.submitted += 1;
    this.timers.schedule(() => this.pump());

    return {
      id,
      promise,
      cancel: (reason?: string) => this.cancel(id, reason),
    };
  }

  /** Bricht einen wartenden oder laufenden Job ab. `true`, wenn er existierte. */
  cancel(id: string, reason = 'cancelled'): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.settled) return false;
    entry.cancelled = true;
    if (entry.started) {
      // Laufender Job: Signal auslösen + sofort als abgebrochen werten; der
      // Slot wird frei, auch wenn der Provider das AbortSignal ignoriert.
      try { entry.controller.abort(reason); } catch { /* ignore */ }
      this.finish(entry, 'cancelled', undefined, new AiJobCancelledError(reason));
      return true;
    }
    const idx = this.queue.indexOf(entry);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.finish(entry, 'cancelled', undefined, new AiJobCancelledError(reason));
    return true;
  }

  /** Wartet, bis Queue und aktive Jobs leer sind (Tests/Shutdown). */
  drain(): Promise<void> {
    if (this.queue.length === 0 && this.active.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.idleResolvers.push(resolve); });
  }

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.cancelled || entry.settled) continue;
      this.start(entry);
    }
    if (this.queue.length === 0 && this.active.size === 0) this.emitIdle();
  }

  private start(entry: RuntimeEntry<unknown>): void {
    entry.started = true;
    entry.startedAt = this.timers.now();
    this.active.add(entry);
    if (this.active.size > this.stats.peakRunning) this.stats.peakRunning = this.active.size;

    const waitedMs = Math.max(0, entry.startedAt - entry.enqueuedAt);
    Promise.resolve()
      .then(() => this.executor(entry.run, entry.controller.signal, entry.timeoutMs, this.timers))
      .then(
        (value) => this.finish(entry, 'completed', value, undefined, waitedMs),
        (error) => {
          const err = error instanceof Error ? error : new Error(String(error));
          const isTimeout = (err as { code?: string }).code === 'AI_JOB_TIMEOUT';
          // Timeout muss auch das Signal auslösen, damit ein laufender
          // Provider-Request (z. B. fetch) wirklich abbricht und nicht weiterläuft.
          if (isTimeout) {
            try { entry.controller.abort('timeout'); } catch { /* ignore */ }
          }
          this.finish(entry, isTimeout ? 'timeout' : 'failed', undefined, err, waitedMs);
        },
      );
  }

  /** Genau einmal je Job auflösen (Cancel/Run/Timeout dürfen sich nicht doppeln). */
  private finish(
    entry: RuntimeEntry<unknown>,
    status: AiRuntimeJobStatus,
    value?: unknown,
    error?: Error,
    waitedMs = Math.max(0, this.timers.now() - entry.enqueuedAt),
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    this.active.delete(entry);
    this.entries.delete(entry.id);
    if (status === 'completed') this.stats.completed += 1;
    else if (status === 'timeout') this.stats.timedOut += 1;
    else if (status === 'cancelled') this.stats.cancelled += 1;
    else if (status === 'failed') this.stats.failed += 1;
    const ranMs = entry.started ? Math.max(0, this.timers.now() - entry.startedAt) : 0;
    entry.resolve({ id: entry.id, status, value, error, waitedMs, ranMs });
    // Nächsten Job erst im nächsten Tick starten → Event-Loop bleibt frei.
    this.timers.schedule(() => this.pump());
  }

  private emitIdle(): void {
    if (this.idleResolvers.length === 0) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}
