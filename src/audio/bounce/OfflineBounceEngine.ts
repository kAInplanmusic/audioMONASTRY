/**
 * audioMONASTRY · Offline-Bounce-Engine (deterministisch)
 * =======================================================
 * Rendert eine Worklet-Kette oder eine V2-Processing-Node-Kette über den
 * AudioGraph – ohne AudioContext, damit Realtime und Offline denselben
 * ProcessingPlan nutzen.
 *
 * Tail-Management: An das Quellmaterial werden `tailSeconds` Stille angehängt,
 * damit Delay-/Reverb-Zustände ausklingen (kein abgeschnittener Hall).
 *
 * Wichtig: State-behaftete Specs/Nodes müssen vor einem Bounce mit `reset()` in
 * einen definierten Zustand gebracht werden (Determinismus).
 */
import { AudioGraph } from '../../core/audio/AudioGraph';
import { SourceNode } from '../../core/audio/nodes/basicNodes';
import { workletGraphRuntime } from '../../core/audio/WorkletGraphRuntime';
import type { IAudioNode, IAudioPort, IProcessingContext } from '../../core/audio/types';

export interface BounceOptions {
  sampleRate?: number;
  /** Nachklangzeit (Reverb-/Delay-Tails) in Sekunden. Default 2 s. */
  tailSeconds?: number;
}

export interface BounceResult {
  output: Float32Array[];
  sampleRate: number;
  renderedFrames: number;
  tailFrames: number;
  durationSeconds: number;
}

export class OfflineBounceEngine {
  constructor(private sampleRate = 48000) {}

  /**
   * Rendert `source` (planar, je Kanal ein Float32Array) durch die registrierte
   * Worklet-Kette `workletIds` und hängt den Tail an. Der gesamte Render läuft
   * als EIN Graph-Durchlauf (kompilierter Plan) – deterministisch und ohne
   * Block-Loops. Nutzt `WorkletGraphRuntime.buildChainGraph()` produktiv.
   */
  bounce(source: Float32Array[], workletIds: string[], opts: BounceOptions = {}): BounceResult {
    const sr = opts.sampleRate ?? this.sampleRate;
    const tailSeconds = opts.tailSeconds ?? 2.0;
    const sourceFrames = source[0]?.length ?? 0;
    const tailFrames = Math.max(0, Math.ceil(tailSeconds * sr));
    const totalFrames = sourceFrames + tailFrames;
    const padded = this.padSource(source, totalFrames);

    // State-behaftete Worklet-Specs (Delay/Reverb) vor jedem Bounce zurücksetzen.
    for (const id of workletIds) {
      workletGraphRuntime.getSpec(id)?.reset?.();
    }
    const chain = workletGraphRuntime.buildChainGraph(workletIds, padded);
    this.processGraph(chain.output, chain.graph, sr, totalFrames);
    return this.result(chain.output.buffer, padded, sr, sourceFrames, tailFrames, totalFrames);
  }

  /**
   * Phase 5: Rendert `source` durch echte V2-Processing-Nodes
   * (ParametricEqNode/DspFilterNode/EffectNode/DynamicsNode/MasteringNode)
   * über denselben AudioGraph wie Realtime/Offline.
   */
  bounceNodeChain(source: Float32Array[], nodes: IAudioNode[], opts: BounceOptions = {}): BounceResult {
    const sr = opts.sampleRate ?? this.sampleRate;
    const tailSeconds = opts.tailSeconds ?? 2.0;
    const sourceFrames = source[0]?.length ?? 0;
    const tailFrames = Math.max(0, Math.ceil(tailSeconds * sr));
    const totalFrames = sourceFrames + tailFrames;
    const padded = this.padSource(source, totalFrames);

    const graph = new AudioGraph();
    const sourceNode = new SourceNode('bounce:source', padded);
    graph.addNode(sourceNode);
    let previousOutput: IAudioPort = sourceNode.outputs[0];
    for (const node of nodes) {
      node.reset();
      // Alte Verbindungen aus früheren Graph-Nutzungen entfernen (Wiederverwendungssicher).
      for (const input of node.inputs) input.disconnect();
      for (const output of node.outputs) output.disconnect();
      graph.addNode(node);
      graph.connect(previousOutput, node.inputs[0]);
      previousOutput = node.outputs[0];
    }
    this.processGraph(previousOutput, graph, sr, totalFrames);
    return this.result(previousOutput.buffer, padded, sr, sourceFrames, tailFrames, totalFrames);
  }

  private padSource(source: Float32Array[], totalFrames: number): Float32Array[] {
    const padded: Float32Array[] = [];
    for (let ch = 0; ch < source.length; ch++) {
      const buf = new Float32Array(totalFrames);
      if (source[ch]) buf.set(source[ch].subarray(0, source[0]?.length ?? 0));
      padded.push(buf);
    }
    return padded;
  }

  private processGraph(_output: IAudioPort, graph: AudioGraph, sr: number, totalFrames: number): void {
    const ctx: IProcessingContext = {
      sampleRate: sr,
      bufferSize: totalFrames,
      quantum: totalFrames / sr,
      currentTime: 0,
    };
    graph.process(ctx);
  }

  private result(
    out: Float32Array[] | null | undefined,
    padded: Float32Array[],
    sr: number,
    sourceFrames: number,
    tailFrames: number,
    totalFrames: number,
  ): BounceResult {
    const output: Float32Array[] = [];
    for (let ch = 0; ch < padded.length; ch++) {
      const src = out?.[ch] ?? out?.[0];
      output.push(src ? src.slice(0, totalFrames) : new Float32Array(totalFrames));
    }
    return {
      output,
      sampleRate: sr,
      renderedFrames: sourceFrames,
      tailFrames,
      durationSeconds: totalFrames / sr,
    };
  }
}

