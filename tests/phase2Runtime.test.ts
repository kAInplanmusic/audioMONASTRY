import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { RuntimeProcessManager, type RuntimeProcess, type RuntimeSpawner } from '../src/core/audio/runtime/RuntimeProcessManager';
import { NativeRuntimeClient } from '../src/core/audio/runtime/NativeRuntimeClient';
import { StdioTransport } from '../src/core/audio/runtime/StdioTransport';
import type { IpcMessage, IpcResponse, IpcTransport } from '../src/core/audio/runtime/ipc';

class MockProcess implements RuntimeProcess {
  id = 'mock-runtime';
  status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  started = 0;
  stopped = 0;

  async start(): Promise<void> { this.status = 'running'; this.started++; }
  async stop(): Promise<void> { this.status = 'stopped'; this.stopped++; }
}

class MockTransport implements IpcTransport {
  sent: IpcMessage[] = [];
  private onMessageCb?: (message: IpcMessage) => void;
  private onResponseCb?: (response: IpcResponse) => void;

  send<T>(message: IpcMessage<T>): void {
    this.sent.push(message as IpcMessage);
    const payload = message.channel === 'device.list' ? { devices: [] } : { pong: true };
    const response: IpcResponse = { id: message.id, ok: true, payload };
    setTimeout(() => this.onResponseCb?.(response), 0);
  }
  onMessage(cb: (message: IpcMessage) => void): void { this.onMessageCb = cb; }
  onResponse(cb: (response: IpcResponse) => void): void { this.onResponseCb = cb; }
  close(): void {}
}

describe('Phase 2 – Native Runtime Integration', () => {
  it('RuntimeProcessManager startet/stoppt/restartet den Prozess', async () => {
    const manager = new RuntimeProcessManager();
    const spawner: RuntimeSpawner = { spawn: async () => new MockProcess() };

    const process = await manager.start(spawner);
    expect(manager.status).toBe('running');
    expect((process as MockProcess).started).toBe(1);

    await manager.restart(spawner);
    expect(manager.status).toBe('running');
    expect((manager.current as MockProcess).started).toBe(1);

    await manager.stop();
    expect(manager.status).toBe('stopped');
  });

  it('NativeRuntimeClient pingt über das IPC-Protokoll', async () => {
    const transport = new MockTransport();
    const client = new NativeRuntimeClient(transport);
    client.connect();

    const res = await client.ping();
    expect(res.pong).toBe(true);
    expect(transport.sent[0].channel).toBe('ping');
    expect(transport.sent[0].protocol).toBe(1);
  });

  it('NativeRuntimeClient listet Devices über IPC', async () => {
    const transport = new MockTransport();
    const client = new NativeRuntimeClient(transport);
    client.connect();

    const res = await client.listDevices();
    expect(res.devices).toEqual([]);
    expect(transport.sent[0].channel).toBe('device.list');
  });

  it('StdioTransport schreibt JSON-Lines und parst Responses', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioTransport(stdin, stdout);

    let received: IpcResponse | undefined;
    transport.onResponse((r) => { received = r; });

    const chunks: Buffer[] = [];
    stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

    transport.send({ protocol: 1, channel: 'ping', id: 'msg-1', payload: {}, timestamp: Date.now() });
    stdout.write(`${JSON.stringify({ id: 'msg-1', ok: true, payload: { pong: true } })}\n`);

    await new Promise((r) => setTimeout(r, 20));
    expect(Buffer.concat(chunks).toString()).toContain('"channel":"ping"');
    expect(received?.ok).toBe(true);
    expect((received?.payload as { pong: boolean }).pong).toBe(true);

    transport.close();
  });
});
