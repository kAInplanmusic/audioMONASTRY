/**
 * audioMONASTRY · Phase 2 – Stdio IPC Transport
 * ============================================
 * Verbindet den NativeRuntimeClient mit einem Kindprozess über
 * stdin/stdout (JSON-Lines). Node-only (Adapter-Schicht).
 */
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { IpcMessage, IpcResponse, IpcTransport } from './ipc';

export class StdioTransport implements IpcTransport {
  private rl: Interface | null = null;
  private closed = false;

  constructor(
    private stdin: Writable,
    stdout: Readable,
  ) {
    this.rl = createInterface({ input: stdout });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof obj.channel === 'string') {
          this.onMessageCb?.(obj as unknown as IpcMessage);
        } else if (typeof obj.id === 'string') {
          this.onResponseCb?.(obj as unknown as IpcResponse);
        }
      } catch {
        // Ignorieren: nicht-JSON-Zeile (z.B. Logging).
      }
    });
  }

  private onMessageCb?: (message: IpcMessage) => void;
  private onResponseCb?: (response: IpcResponse) => void;

  send<T>(message: IpcMessage<T>): void {
    if (this.closed) return;
    this.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(cb: (message: IpcMessage) => void): void {
    this.onMessageCb = cb;
  }

  onResponse(cb: (response: IpcResponse) => void): void {
    this.onResponseCb = cb;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl?.close();
    try {
      this.stdin.end();
    } catch {
      // Bereits geschlossen.
    }
  }
}
