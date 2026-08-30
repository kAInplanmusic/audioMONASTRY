/**
 * audioMONASTRY · Offline-Bounce-Engine (deterministisch)
 * =======================================================
 * Rendert eine Worklet-Kette über den AudioGraph – ohne AudioContext, damit
 * Realtime und Offline denselben ProcessingPlan nutzen.
 *
 * Tail-Management: An das Quellmaterial werden `tailSeconds` Stille angehängt,
 * damit Delay-/Reverb-Zustände ausklingen (kein abgeschnittener Hall).
 *
 * Wichtig: State-behaftete Specs müssen vor einem Bounce mit `reset()` in
 * einen definierten Zustand gebracht werden (Determinismus).
 */
import { AudioGraph } from '../../core/audio/AudioGraph';
import { SourceNode } from '../../core/audio/nodes/basicNodes';
import { WorkletProcessorAdapter } from '../../core/audio/backends/WorkletAdapter';
import { workletGraphRuntime } from '../../core/audio/WorkletGraphRuntime';
import type { IProcessingContext } from '../../core/audio/types';

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
   * Rendert `source` (planar, je Kanal ein Float32Array) durch die Kette
   * `workletIds` und hängt den Tail an. Der gesamte Render läuft als EIN
   * Graph-Durchlauf (kompilierter Plan) – deterministisch und ohne Block-Loops.
   */
  bounce(source: Float32Array[], workletIds: string[], opts: BounceOptions = {}): BounceResult {
    const sr = opts.sampleRate ?? this.sampleRate;
    const tailSeconds = opts.tailSeconds ?? 2.0;

    const sourceFrames = source[0]?.length ?? 0;
    const tailFrames = Math.max(0, Math.ceil(tailSeconds * sr));
    const totalFrames = sourceFrames + tailFrames;

    // Quellmaterial + Stille-Tail planar zusammenführen.
    const padded: Float32Array[] = [];
    for (let ch = 0; ch < source.length; ch++) {
      const buf = new Float32Array(totalFrames);
      if (source[ch]) buf.set(source[ch].subarray(0, sourceFrames));
      padded.push(buf);
    }

    const graph = new AudioGraph();
    const sourceNode = new SourceNode('bounce:source', padded);
    graph.addNode(sourceNode);

    let previousOutput = sourceNode.outputs[0];
    for (const id of workletIds) {
      const spec = workletGraphRuntime.getSpec(id);
      if (!spec) throw new Error(`Worklet nicht registriert: ${id}`);
      // State-behaftete Specs (Delay/Reverb) in den Urzustand versetzen,
      // damit jeder Bounce bit-identisch ist (Golden-Master).
      spec.reset?.();
      const adapter = new WorkletProcessorAdapter(`bounce:${id}`, spec.type, spec.process, spec.inputs, spec.outputs);
      graph.addNode(adapter);
      graph.connect(previousOutput, adapter.inputs[0]);
      previousOutput = adapter.outputs[0];
    }

    const ctx: IProcessingContext = {
      sampleRate: sr,
      bufferSize: totalFrames,
      quantum: totalFrames / sr,
      currentTime: 0,
    };
    graph.process(ctx);

    const out = previousOutput.buffer;
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

/** Standard-Engine für Bounces (kann je Session neu erzeugt werden). */
export const offlineBounceEngine = new OfflineBounceEngine();
