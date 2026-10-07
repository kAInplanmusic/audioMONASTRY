/**
 * audioMONASTRY · Phase 1, Schritt 3 – Worklet → ProcessingPlan-Adapter
 * ======================================================================
 * Bindet AudioWorklet-Prozessoren als IAudioNode an den ProcessingPlan.
 */
import { AudioParameter, AudioPort } from '../AudioGraph';
import { ensureBufferSet } from '../PortBuffers';
import type { IAudioNode, IAudioPort, IProcessingContext } from '../types';

const NO_CHANNELS: Float32Array[] = [];

export type WorkletProcessFn = (input: Float32Array[][], output: Float32Array[][], ctx: IProcessingContext) => void;

export class WorkletProcessorAdapter implements IAudioNode {
  readonly inputs: AudioPort[];
  readonly outputs: AudioPort[];
  readonly parameters: AudioParameter[] = [];
  /**
   * RT-AUDIT-P0-002: feste Container + Puffer statt `map()`/Pool pro Block.
   * `outBuffers` hält je Ausgang EINEN Satz; der Prozessor schreibt hinein
   * (oder ersetzt `output[i]` durch einen eigenen Satz).
   */
  private readonly inChannels: Float32Array[][];
  private readonly outChannels: Float32Array[][];
  private readonly outBuffers: (Float32Array[] | null)[];

  constructor(
    public readonly id: string,
    public readonly type: string,
    public readonly processFn: WorkletProcessFn,
    inputs = 1,
    outputs = 1,
  ) {
    this.inputs = Array.from({ length: inputs }, (_, i) => new AudioPort(this, 'input', `${id}:in${i}`));
    this.outputs = Array.from({ length: outputs }, (_, i) => new AudioPort(this, 'output', `${id}:out${i}`));
    this.inChannels = Array.from({ length: inputs }, () => NO_CHANNELS);
    this.outChannels = Array.from({ length: outputs }, () => NO_CHANNELS);
    this.outBuffers = Array.from({ length: outputs }, () => null);
  }

  process(ctx: IProcessingContext): void {
    const inChannels = this.inChannels;
    for (let i = 0; i < this.inputs.length; i++) {
      inChannels[i] = this.inputs[i].connections[0]?.buffer ?? NO_CHANNELS;
    }
    const len = inChannels[0]?.[0]?.length ?? ctx.bufferSize;
    const outChannels = this.outChannels;
    for (let i = 0; i < this.outputs.length; i++) {
      const set = ensureBufferSet(this.outBuffers[i], 2, len);
      this.outBuffers[i] = set;
      // Wie der fruehere frische Pool-Puffer: geleert uebergeben.
      set[0].fill(0);
      set[1].fill(0);
      outChannels[i] = set;
    }

    this.processFn(inChannels, outChannels, ctx);
    for (let i = 0; i < this.outputs.length; i++) this.outputs[i].buffer = outChannels[i];
  }

  reset(): void {
    this.outputs.forEach((port) => { port.buffer = null; });
  }
}

export type { IAudioPort };
