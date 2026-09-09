/**
 * audioMONASTRY · Phase 1 – Worklet → AudioGraph Runtime
 * ======================================================
 * Hängt AudioWorklet-Prozessoren (itSynth/mastering/eq/…) als
 * WorkletProcessorAdapter in einen gemeinsamen ProcessingPlan ein.
 * Dies ist der Migrationspfad, damit Worklets und Graph dieselbe Struktur
 * nutzen (Realtime + Offline identisch).
 */
import { AudioGraph } from './AudioGraph';
import { SourceNode } from './nodes/basicNodes';
import { WorkletProcessorAdapter, type WorkletProcessFn } from './backends/WorkletAdapter';
import type { IAudioNode, IAudioPort, IProcessingContext } from './types';

export interface WorkletSpec {
  id: string;
  type: string;
  inputs: number;
  outputs: number;
  process: WorkletProcessFn;
  /** Optional: setzt state-behaftete Specs (Delay/Reverb) in den Urzustand. */
  reset?: () => void;
}

export interface WorkletChainResult {
  graph: AudioGraph;
  nodes: IAudioNode[];
  output: Float32Array[] | null;
}

export interface WorkletChainGraphResult {
  graph: AudioGraph;
  nodes: IAudioNode[];
  sourceNode: SourceNode;
  /** Letzter Output-Port der Kette (für weitere Verdrahtung oder Bounce). */
  output: IAudioPort;
}

export class WorkletGraphRuntime {
  private specs = new Map<string, WorkletSpec>();

  registerWorklet(spec: WorkletSpec): void {
    this.specs.set(spec.id, spec);
  }

  getSpec(id: string): WorkletSpec | undefined {
    return this.specs.get(id);
  }

  listWorklets(): string[] {
    return [...this.specs.keys()];
  }

  /** Setzt einen state-behafteten Worklet-Spec zurück (z. B. vor einem Bounce). */
  resetWorklet(id: string): void {
    this.specs.get(id)?.reset?.();
  }

  /** Setzt alle registrierten Worklet-Specs zurück. */
  resetAllWorklets(): void {
    for (const spec of this.specs.values()) spec.reset?.();
  }

  /**
   * Baut Source → Worklet1 → Worklet2 → … als kompilierten Graphen, ohne zu
   * verarbeiten. So kann dieselbe Kette in Realtime-Graphen, Offline-Bouncen
   * und Tests produktiv weiterverwendet werden.
   */
  buildChainGraph(workletIds: string[], source: Float32Array[]): WorkletChainGraphResult {
    const graph = new AudioGraph();
    const sourceNode = new SourceNode('source:chain', source);
    graph.addNode(sourceNode);

    const nodes: IAudioNode[] = [sourceNode];
    let previousOutput = sourceNode.outputs[0];

    for (const id of workletIds) {
      const spec = this.specs.get(id);
      if (!spec) throw new Error(`Worklet nicht registriert: ${id}`);
      const adapter = new WorkletProcessorAdapter(`worklet:${id}`, spec.type, spec.process, spec.inputs, spec.outputs);
      graph.addNode(adapter);
      graph.connect(previousOutput, adapter.inputs[0]);
      nodes.push(adapter);
      previousOutput = adapter.outputs[0];
    }

    const plan = graph.compile();
    if (!plan.validated) throw new Error('Worklet-Kette enthält einen Zyklus');

    return { graph, nodes, sourceNode, output: previousOutput };
  }

  /** Baut Source → Worklet1 → Worklet2 → … und verarbeitet genau einen Block. */
  buildChain(workletIds: string[], source: Float32Array[], ctx: IProcessingContext): WorkletChainResult {
    const chain = this.buildChainGraph(workletIds, source);
    chain.graph.process(ctx);
    return { graph: chain.graph, nodes: chain.nodes, output: chain.output.buffer };
  }
}

export const workletGraphRuntime = new WorkletGraphRuntime();
