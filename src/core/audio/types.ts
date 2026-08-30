/**
 * audioMONASTRY · Phase 1 – Backend-unabhängige Audio-Runtime-Abstraktion
 * =======================================================================
 * Diese Typen haben KEINE WebAudio-/Browser-Abhängigkeit. Sie sind der
 * gemeinsame Nenner für WebAudio-, WASM- und Native-Backends.
 */

/** Mehrkanal-Audio-Buffer (planar, Float32, deterministisch). */
export interface IAudioBuffer {
  readonly id: string;
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  channelData: Float32Array[];
  /** Kopie mit identischen Dimensionen. */
  clone(): IAudioBuffer;
  /** Leeren Buffer gleicher Größe erzeugen (Buffer-Pooling-freundlich). */
  createEmpty(): IAudioBuffer;
}

export type AudioPortKind = 'input' | 'output';

export interface IAudioPort {
  readonly id: string;
  readonly kind: AudioPortKind;
  readonly node: IAudioNode;
  readonly connections: IAudioPort[];
  /** Audio-Daten, die dieser Port aktuell trägt (planar). */
  buffer: Float32Array[] | null;
  connect(target: IAudioPort): void;
  disconnect(target?: IAudioPort): void;
}

export interface AutomationPoint {
  time: number; // Sekunden innerhalb des Buffers/Graphs
  value: number;
}

export interface IAudioParameter {
  readonly id: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  value: number;
  readonly automation: AutomationPoint[];
  setValue(value: number): void;
  setValueAtTime(value: number, time: number): void;
  /** Linear interpolierter Wert zu einem Zeitpunkt. */
  getValueAtTime(time: number): number;
  reset(): void;
}

export interface IProcessingContext {
  readonly sampleRate: number;
  readonly bufferSize: number;
  currentTime: number;
  readonly quantum: number;
}

/**
 * Backend-unabhängiger Audio-Knoten.
 * Implementierungen müssen deterministisch sein und dürfen keine
 * globalen Browser-Audio-Objekte referenzieren.
 */
export interface IAudioNode {
  readonly id: string;
  readonly type: string;
  readonly inputs: IAudioPort[];
  readonly outputs: IAudioPort[];
  readonly parameters: IAudioParameter[];
  process(ctx: IProcessingContext): void;
  reset(): void;
}

/** Ein geordneter, zyklenfreier Verarbeitungsplan. */
export interface ProcessingPlan {
  readonly nodes: IAudioNode[];
  readonly order: string[];
  readonly validated: boolean;
}

export interface IAudioGraph {
  addNode(node: IAudioNode): void;
  removeNode(nodeOrId: IAudioNode | string): void;
  connect(source: IAudioPort, target: IAudioPort): void;
  disconnect(source: IAudioPort, target?: IAudioPort): void;
  compile(): ProcessingPlan;
  process(ctx: IProcessingContext): void;
  /** Liefert den Output-Buffer des letzten verarbeiteten Knotens. */
  getLastOutput(): Float32Array[] | null;
  reset(): void;
}
