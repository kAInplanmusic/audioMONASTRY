/**
 * audioMONASTRY · Phase 2 – Runtime Process Manager
 * =================================================
 * Verwaltet den Lebenszyklus des audioMONASTRY-runtime Prozesses
 * (Rust/Native). Die eigentliche Prozess-Erzeugung wird über einen
 * RuntimeSpawner abstrahiert, damit Tests ohne echten Prozess laufen.
 */

export type RuntimeProcessStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface RuntimeProcess {
  readonly id: string;
  readonly status: RuntimeProcessStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeSpawner {
  spawn(): Promise<RuntimeProcess>;
}

export class RuntimeProcessManager {
  private process: RuntimeProcess | null = null;

  get status(): RuntimeProcessStatus {
    return this.process?.status ?? 'stopped';
  }

  get current(): RuntimeProcess | null {
    return this.process;
  }

  async start(spawner: RuntimeSpawner): Promise<RuntimeProcess> {
    if (this.process && this.process.status === 'running') return this.process;
    const next = await spawner.spawn();
    await next.start();
    this.process = next;
    return next;
  }

  async stop(): Promise<void> {
    if (this.process) await this.process.stop();
    this.process = null;
  }

  async restart(spawner: RuntimeSpawner): Promise<RuntimeProcess> {
    await this.stop();
    return this.start(spawner);
  }
}
