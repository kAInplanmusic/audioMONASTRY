/**
 * audioMONASTRY · Phase 2 – NativeRuntimeClient
 * =============================================
 * IPC-Client für den audioMONASTRY-runtime Prozess (Rust). Nutzt das
 * versionierte IpcMessage/IpcResponse-Protokoll aus ./ipc.ts.
 */
import {
  createIpcMessage,
  type IpcMessage,
  type IpcResponse,
  type IpcTransport,
} from './ipc';

export class NativeRuntimeClient {
  private pending = new Map<string, { resolve: (v: IpcResponse) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  private connected = false;

  constructor(private transport: IpcTransport) {
    transport.onResponse((response) => {
      const entry = this.pending.get(response.id);
      if (entry) {
        this.pending.delete(response.id);
        if (response.ok) entry.resolve(response);
        else entry.reject(new Error(response.error ?? 'Native-Runtime-Fehler'));
      }
    });
    transport.onMessage((message) => {
      this.handlers.get(message.channel)?.forEach((cb) => cb(message.payload));
    });
  }

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    for (const [, entry] of this.pending) entry.reject(new Error('Client getrennt'));
    this.pending.clear();
    this.transport.close();
  }

  on(channel: string, cb: (payload: unknown) => void): void {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel)!.add(cb);
  }

  request<T = unknown>(channel: IpcMessage['channel'], payload: unknown, timeoutMs = 5000): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('Client nicht verbunden'));
    const message = createIpcMessage(channel, payload);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error(`Runtime-Timeout: ${channel}`));
      }, timeoutMs);
      this.pending.set(message.id, {
        resolve: (res) => {
          clearTimeout(timer);
          resolve(res.payload as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.transport.send(message);
    });
  }

  ping(): Promise<{ pong: boolean }> {
    return this.request('ping', {});
  }

  syncGraph(payload: unknown): Promise<unknown> {
    return this.request('graph.sync', payload);
  }

  listDevices(): Promise<{ devices: unknown[] }> {
    return this.request<{ devices: unknown[] }>('device.list', {});
  }

  openDevice(deviceId: string): Promise<unknown> {
    return this.request('device.open', { deviceId });
  }

  renderOffline(payload: unknown): Promise<unknown> {
    return this.request('render.offline', payload);
  }

  processGraph(payload: {
    input_base64: string;
    gain: number;
    drive: number;
    ceiling?: number;
    eq_low_db?: number;
    eq_mid_db?: number;
    eq_high_db?: number;
    sample_rate?: number;
    channels?: number;
  }): Promise<{ output_base64: string; samples: number }> {
    return this.request('graph.process', payload);
  }
}
