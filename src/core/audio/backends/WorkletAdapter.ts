/**
 * audioMONASTRY · Phase 1, Schritt 3 – Worklet → ProcessingPlan-Adapter
 * ======================================================================
 * Bindet AudioWorklet-Prozessoren als IAudioNode an den ProcessingPlan.
 */
import { AudioParameter, AudioPort } from '../AudioGraph';
import { audioBufferPool } from '../BufferPool';
import type { IAudioNode, IAudioPort, IProcessingContext } from '../types';

export type WorkletProcessFn = (input: Float32Array[][], output: Float32Array[][], ctx: IProcessingContext) => void;

export class WorkletProcessorAdapter implements IAudioNode {
  readonly inputs: AudioPort[];
  readonly outputs: AudioPort[];
  readonly parameters: AudioParameter[] = [];

  constructor(
    public readonly id: string,
    public readonly type: string,
    public readonly processFn: WorkletProcessFn,
    inputs = 1,
    outputs = 1,
  ) {
    this.inputs = Array.from({ length: inputs }, (_, i) => new AudioPort(this, 'input', `${id}:in${i}`));
    this.outputs = Array.from({ length: outputs }, (_, i) => new AudioPort(this, 'output', `${id}:out${i}`));
  }

  process(ctx: IProcessingContext): void {
    const inChannels: Float32Array[][] = this.inputs.map((port) => {
      const src = port.connections[0]?.buffer ?? [];
      return src;
    });
    const len = inChannels[0]?.[0]?.length ?? ctx.bufferSize;
    const outChannels: Float32Array[][] = this.outputs.map(() => audioBufferPool.acquire(2, len));

    this.processFn(inChannels, outChannels, ctx);
    this.outputs.forEach((port, i) => { port.buffer = outChannels[i]; });
  }

  reset(): void {
    this.outputs.forEach((port) => { port.buffer = null; });
  }
}

export type { IAudioPort };
