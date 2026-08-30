/**
 * audioMONASTRY · Phase 2 – NativeRuntimeSpawner
 * ==============================================
 * Startet den kompilierten Rust-Prozess (services/audio-runtime) und
 * verbindet ihn per StdioTransport.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioTransport } from './StdioTransport';
import type { IpcTransport } from './ipc';
import type { RuntimeProcess, RuntimeSpawner } from './RuntimeProcessManager';

export class NativeRuntimeProcess implements RuntimeProcess {
  id = 'native-runtime';
  status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';

  private child: ChildProcess | null = null;
  transport: IpcTransport | null = null;

  constructor(private binPath: string) {}

  async start(): Promise<void> {
    this.status = 'starting';
    this.child = spawn(this.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.transport = new StdioTransport(this.child.stdin!, this.child.stdout!);
    this.child.stderr?.on('data', () => { /* Logging absichtlich verworfen */ });
    this.child.on('error', () => { this.status = 'error'; });
    this.child.on('exit', () => { this.status = 'stopped'; this.transport = null; });
    this.status = 'running';
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.transport?.close();
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.status = 'stopped';
  }
}

export class NativeRuntimeSpawner implements RuntimeSpawner {
  private binPath: string;

  constructor(binPath?: string) {
    this.binPath = binPath ?? resolve(process.cwd(), 'services/audio-runtime/target/release/audiomonastry-runtime');
  }

  get available(): boolean {
    return existsSync(this.binPath);
  }

  async spawn(): Promise<RuntimeProcess> {
    if (!this.available) {
      throw new Error(`Native Runtime Binary fehlt: ${this.binPath} (cargo build --release in services/audio-runtime)`);
    }
    return new NativeRuntimeProcess(this.binPath);
  }
}
