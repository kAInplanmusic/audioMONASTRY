import { Worker } from 'node:worker_threads';
import { resolve, dirname } from 'node:path';
import type { BackendMainRate } from '../src/core/transport/backendMainProtocol';
import type { MainMixResult } from './backendMainMixer';
import type { MainProcessorSnapshot } from './backendMainProcessors';
export interface WorkerBlock extends Omit<MainMixResult, 'pcm'> { type: 'block'; pcm: ArrayBuffer; snapshot: MainProcessorSnapshot; sourceIds: string[]; streamIds: Record<string,string>; renderedFrames: number; lagMs: number; renderMs: number }
export class BackendMainWorkerClient {
  readonly worker: Worker;
  frame = 0;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  readonly ready: Promise<void>;
  constructor(readonly sampleRate: BackendMainRate, callbacks: { block: (block: WorkerBlock) => void; error: (error: Error) => void; metrics?: (value: unknown) => void }) {
    const built = process.argv[1]?.endsWith('.cjs');
    const path = built ? resolve(dirname(process.argv[1]), 'backendMainWorker.cjs') : resolve('server/backendMainWorker.ts');
    const bootstrap = built ? `require(${JSON.stringify(path)})` : `require('tsx/cjs');require(${JSON.stringify(path)})`;
    this.worker = new Worker(bootstrap, { eval: true, workerData: { sampleRate } });
    this.ready = new Promise((resolveReady, rejectReady) => {
      const fail = (error: Error) => {
        if (this.closed) return; this.closed = true; rejectReady(error);
        for (const p of this.pending.values()) p.reject(error); this.pending.clear(); callbacks.error(error);
        void this.worker.terminate();
      };
      this.worker.on('error', fail);
      this.worker.on('exit', code => { if (!this.closed) fail(new Error(`Main audio worker exited ${code}`)); });
      this.worker.on('message', message => {
        if (typeof message.frame === 'number') this.frame = message.frame;
        if (message.type === 'ready') resolveReady();
        else if (message.type === 'fatal') fail(new Error(message.error));
        else if (message.type === 'block') { this.frame = message.renderedFrames; callbacks.block(message); }
        else if (message.type === 'metrics') callbacks.metrics?.(message);
        else if (message.id !== undefined) {
          const p = this.pending.get(message.id); this.pending.delete(message.id);
          if (message.error) p?.reject(new Error(message.error)); else p?.resolve(message);
        }
      });
    });
    // Constructor users await ready; keep early worker failures from becoming unhandled.
    void this.ready.catch(() => {});
  }
  private request(type: string, data: Record<string, unknown> = {}, transfers: ArrayBuffer[] = []): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Main worker is closed'));
    const id = ++this.nextId;
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject }); this.worker.postMessage({ type, id, ...data }, transfers);
    });
  }
  async state() { await this.ready; return this.request('state'); }
  enqueue(plugin: string, sequence: number, frame: number, pcm: Uint8Array, streamId = plugin) {
    const bytes = new Uint8Array(pcm); // WS Buffer slabs cannot be transferred safely.
    return this.request('enqueue', { plugin, sequence, frame, streamId, pcm: bytes.buffer }, [bytes.buffer]);
  }
  snapshot(snapshot: MainProcessorSnapshot) { if (!this.closed) this.worker.postMessage({ type: 'snapshot', snapshot }); }
  removeTrack(plugin: string) { if (!this.closed) this.worker.postMessage({ type: 'remove', plugin }); }
  pruneDrainedTracks(active: Set<string>) { if (!this.closed) this.worker.postMessage({ type: 'prune', active: [...active] }); }
  ack(bytes: number) { if (!this.closed) this.worker.postMessage({ type: 'ack', bytes }); }
  testDelay(ms: number) { this.worker.postMessage({ type: 'test-delay', ms }); }
  testCrash() { this.worker.postMessage({ type: 'test-crash' }); }
  close() { if (this.closed) return; this.closed = true; for (const p of this.pending.values()) p.reject(new Error('Main worker closed')); this.pending.clear(); void this.worker.terminate(); }
}
