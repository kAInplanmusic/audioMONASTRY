import type { IAudioBuffer, IAudioGraph, IProcessingContext } from '../types';

/** Gemeinsame Schnittstelle aller AudioGraph-Backends. */
export interface IAudioGraphBackend {
  readonly id: string;
  readonly kind: 'webaudio' | 'wasm' | 'native';
  readonly available: boolean;
  initialize(): Promise<void>;
  createGraph(): IAudioGraph;
  createBuffer(sampleRate: number, length: number, channels: number): IAudioBuffer;
  /** Rendert den Graph in einen Ausgabe-Buffer. */
  render(graph: IAudioGraph, ctx: IProcessingContext, output: IAudioBuffer): Promise<void>;
  dispose(): Promise<void>;
}
