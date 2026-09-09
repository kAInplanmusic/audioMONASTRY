/**
 * audioMONASTRY · V2OutputGraph (Phase 4 – Spatial-Bus/2.1-Mehrkanal in V2)
 * =========================================================================
 * Backend-unabhängiger Ausgangs-Graph für Master → Geräte-Layout:
 *
 *   stereo → StereoSum (2.0/Phantom)
 *   2.1    → Stereo21OutputNode (L/R + LFE, Linkwitz-Riley)
 *   N.x    → MultichannelBusNode (Mono-Ring mit frei konfigurierbaren Gewichten)
 *
 * Der Graph verarbeitet denselben `AudioGraph`-Plan wie Realtime/Offline und
 * erlaubt Layout-Wechsel ohne Browser-API. Er kann direkt hinter den
 * V2-Monitor-/Main-Bus gehängt oder als eigenständiger Test-/Render-Baustein
 * verwendet werden.
 */
import { AudioGraph } from './AudioGraph';
import { MultichannelBusNode, SourceNode, Stereo21OutputNode, StereoSumNode } from './nodes/basicNodes';
import type { IAudioNode, IProcessingContext } from './types';
import { getOutputLayout } from '../spatial/layouts';

export type V2OutputLayoutId = string;

const STEREO_IDS = new Set(['stereo', '2.0']);

/** Ermittelt die Kanalzahl eines Ausgabe-Layouts (2.0/2.1/4.0/…). */
export function v2OutputChannelCount(layoutId: string): number {
  if (layoutId === '2.1') return 3;
  if (STEREO_IDS.has(layoutId)) return 2;
  return getOutputLayout(layoutId)?.channelCount ?? 2;
}

export class V2OutputGraph {
  readonly graph = new AudioGraph();
  private readonly source = new SourceNode('v2out:source', [new Float32Array(0)], 48000);
  private outputNode: IAudioNode | null = null;
  private currentLayoutId = 'stereo';
  private readonly sampleRate: number;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.graph.addNode(this.source);
    this.setLayout('stereo');
  }

  get layoutId(): string {
    return this.currentLayoutId;
  }

  /** Übergibt den Stereo-Master-Block (planar) an den Ausgangs-Graph. */
  setInput(input: Float32Array[]): void {
    if (!input || input.length === 0) return;
    const left = input[0] ?? new Float32Array(input[0]?.length ?? 0);
    const right = input[1] ?? left;
    this.source.sourceBuffer = [left, right];
  }

  setInputStereo(left: Float32Array, right?: Float32Array | null): void {
    this.source.sourceBuffer = [left, right ?? left];
  }

  /**
   * Wechselt das Ausgabe-Layout.
   *  - stereo/2.0 → Stereo
   *  - 2.1        → L/R/LFE (Crossover)
   *  - alle Layouts aus `src/core/spatial/layouts.ts` → Mehrkanal-Bus
   */
  setLayout(layoutId: string): void {
    const id = layoutId || 'stereo';
    if (id === this.currentLayoutId && this.outputNode) return;

    if (this.outputNode) this.graph.removeNode(this.outputNode);
    this.currentLayoutId = id;

    if (id === '2.1') {
      this.outputNode = new Stereo21OutputNode('v2out:21', this.sampleRate, 90);
      this.graph.addNode(this.outputNode);
      this.graph.connect(this.source.outputs[0], this.outputNode.inputs[0]);
      return;
    }

    const count = v2OutputChannelCount(id);
    if (count <= 2) {
      const stereo = new StereoSumNode('v2out:stereo', 1, 1, 2);
      this.outputNode = stereo;
    } else {
      const multi = new MultichannelBusNode('v2out:spatial', count);
      // Neutraler Start: gleichmäßige Omni-Verteilung (kann per setSpatialWeights
      // auf VBAP-/Raumplaner-Gewichte gestellt werden).
      multi.setChannelGains(Array.from({ length: count }, () => 1 / count));
      this.outputNode = multi;
    }
    this.graph.addNode(this.outputNode);
    this.graph.connect(this.source.outputs[0], this.outputNode.inputs[0]);
  }

  /** Setzt die Kanal-Gewichte eines Spatial-Busses (nur bei Mehrkanal-Layouts). */
  setSpatialWeights(weights: readonly number[]): void {
    const node = this.outputNode as MultichannelBusNode | null;
    if (node && typeof (node as MultichannelBusNode).setChannelGains === 'function') {
      node.setChannelGains(weights);
    }
  }

  /** Verarbeitet einen Block und liefert das Layout-konforme Ausgangssignal. */
  render(ctx: IProcessingContext): Float32Array[] | null {
    this.graph.process(ctx);
    return this.outputNode?.outputs[0]?.buffer ?? null;
  }

  reset(): void {
    this.graph.reset();
    if (this.outputNode) this.outputNode.reset();
  }
}
