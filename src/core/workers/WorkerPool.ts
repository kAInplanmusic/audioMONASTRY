
/**
 * audioMONASTRY · Worker-Pool (Aufg. 2.2.2 / 1.1.3)
 * ---------------------------------------------------
 * Multi-Core-Auslagerung für CPU-intensive, NICHT-echtzeitkritische (Offline-)
 * Jobs. Hält den Main- und Audio-Thread immer reaktionsfähig.
 *
 * - Größe: egal `navigator.hardwareConcurrency` (min 2, max 8).
 * - Round-Robin-Zuteilung; jobbasierte Auflösung mit Timeout.
 * - Fallback auf Main-Thread, wenn Worker (CSP/Parcel) blockiert.
 */
import { computeWorkerUrl } from './computeWorkerUrl';

export interface PoolOptions {
  size?: number;
  timeoutMs?: number;
}

interface PendingJob {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

class WorkerPoolImpl {
  private workers: Worker[] = [];
  private idle: number[] = [];
  private queue: { task: string; input: unknown; pending: PendingJob }[] = [];
  private seq = 0;
  private started = false;
  private timeoutMs = 30_000;
  private errorLogged = false;

  /** Lazy-Initialisierung; wird erst beim ersten submit() ausgelöst. */
  private ensureStarted(size = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4)))) {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < size; i++) {
      try {
        const w = new Worker(computeWorkerUrl, { type: 'module' });
        this.workers.push(w);
        this.idle.push(i);
        w.onmessage = (e) => this.onMessage(w, e.data);
        w.onerror = (e) => this.onError(w, e.message);
      } catch {
        /* Worker blockiert → Fallback auf Main-Thread. */
      }
    }
  }

  async submit<T = any, R = any>(task: string, input: unknown, opts?: PoolOptions): Promise<R> {
    const timeout = opts?.timeoutMs ?? this.timeoutMs;
    // Kein Worker verfügbar → direkte lokale Ausführung (main thread).
    if (!this.workers.length && !this.buildErrorLogged()) {
      return (await import('../computeLocal')).computeLocal(task, input) as R;
    }
    this.ensureStarted(opts?.size);
    if (!this.workers.length) {
      return (await import('../computeLocal')).computeLocal(task, input) as R;
    }

    return new Promise<R>((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => reject(new Error(`Worker-Task-Timeout: ${task}`)), timeout) : null;
      this.queue.push({ task, input, pending: { resolve: resolve as (v: unknown) => void, reject, timer } });
      this.drain();
    });
  }

  private buildErrorLogged(): boolean { return false; }

  private drain() {
    while (this.idle.length && this.queue.length) {
      const wi = this.idle.shift()!;
      const job = this.queue.shift()!;
      const worker = this.workers[wi];
      if (!worker) continue;
      const jobId = ++this.seq;
      worker.postMessage({ id: jobId, task: job.task, input: job.input });
      const handler = (data: { id: number; ok?: boolean; out?: unknown; error?: string }) => {
        if (data.id !== jobId) return;
        if (job.pending.timer) clearTimeout(job.pending.timer);
        this.idle.push(wi);
        data.ok ? job.pending.resolve(data.out) : job.pending.reject(new Error(data.error || 'Worker-Fehler'));
        this.drain();
      };
      (worker as any).__pendingHandler = handler;
    }
  }

  private onMessage(worker: Worker, data: { id: number; ok?: boolean; out?: unknown; error?: string }) {
    const h = (worker as any).__pendingHandler as ((d: { id: number; ok?: boolean; out?: unknown; error?: string }) => void) | undefined;
    if (h) h(data);
  }

  private onError(_worker: Worker, _msg: string) {
    if (!this.errorLogged) {
      console.warn('Worker-Pool: Worker Fehler/terminiert – Fallback auf Main-Thread.', _msg);
      this.errorLogged = true;
    }
  }

  shutdown() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.idle = [];
    this.started = false;
  }
}

export const workerPool = new WorkerPoolImpl();
export default workerPool;
