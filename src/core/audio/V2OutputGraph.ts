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
 *
 */

import { AudioGraph } from './AudioGraph';
import {
  MultichannelBusNode,
  SourceNode,
  Stereo21OutputNode,
  StereoSumNode,
} from './nodes/basicNodes';
import type { IAudioNode, IProcessingContext } from './types';
import { getOutputLayout } from '../spatial/layouts';
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
  /** RT-AUDIT-P0-002: festes Zwei-Element-Array für den Quell-Block (vorher
   * pro Block `[left, right]`); nur die Einträge werden gesetzt.
   */
  private readonly stereoInput: Float32Array[] = [new Float32Array(0), new Float32Array(0)];

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
    const left = input[0];
    this.setInputStereo(left, input[1] ?? left);
  }

  setInputStereo(left: Float32Array, right?: Float32Array | null): void {
    const block = this.stereoInput;
    block[0] = left;
    block[1] = right ?? left;
    this.source.sourceBuffer = block;
  }

  /**
   * Formatiert den fertigen Stereo-Block für den Ausgang. Die Auswahl
   * einzelner Spatial-Main-Quellen erfolgt vor der Stereo-Summe.
   */
  setLayout(layoutId: string): void {
    const id = layoutId || 'stereo';
    if (id === this.currentLayoutId && this.outputNode) return;
    const count = v2OutputChannelCount(id);

    let nextOutput: IAudioNode;
    if (id === '2.1') {
      nextOutput = new Stereo21OutputNode('v2out:21', this.sampleRate, 90);
    } else if (count <= 2) {
      nextOutput = new StereoSumNode('v2out:stereo', 1, 1, 2);
    } else {
      const spatial = new MultichannelBusNode('v2out:spatial', count);
      spatial.setChannelGains(Array.from({ length: count }, () => 1 / count));
      nextOutput = spatial;
    }

    if (this.outputNode) this.graph.removeNode(this.outputNode);
    this.graph.addNode(nextOutput);
    this.graph.connect(this.source.outputs[0], nextOutput.inputs[0]);
    this.outputNode = nextOutput;
    this.currentLayoutId = id;
  }

  /** Setzt die Kanal-Gewichte eines Spatial-Busses (nur bei Mehrkanal-Layouts). */
  setSpatialWeights(weights: readonly number[]): void {
    if (this.outputNode instanceof MultichannelBusNode) {
      this.outputNode.setChannelGains(weights);
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
