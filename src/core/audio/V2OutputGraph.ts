/**
 * audioMONASTRY · V2OutputGraph (Phase 4 – Spatial-Bus/2.1-Mehrkanal in V2)
 * =========================================================================
 * Backend-unabhängiger Ausgangs-Graph für Master → Geräte-Layout:
 *
 *   stereo → StereoSum (2.0/Phantom)
 *   2.1    → Stereo21OutputNode (L/R + LFE, Linkwitz-Riley)
 *   N.x    → MultichannelBusNode (Mono-Ring mit frei konfigurierbaren Gewichte)
 *
 * Der Graph verarbeitet denselben `AudioGraph`-Plan wie Realtime/Offline und
 * erlaubt Layout-Wechsel ohne Browser-API. Er kann direkt hinter den
 * V2-Monitor-/Main-Bus gehängt oder als eigenständiger Test-/Render-Baustein
 * verwendet werden.
 *
 * SP-P0-02: Graph-Routing pro Modus vollständig integriert.
 *   - routingPlan.ts: createSpatialRoutingPlanV2, verifySpatialRoutingPartitionV2
 *   - nonDestructiveTap.ts: NonDestructiveSpatialTapRegistry
 *   - setSpatialWeights() weist VBAP/Routing-Gewichte zu statt neutraler Omni-Verteilung
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
import {
  createSpatialRoutingPlanV2,
  verifySpatialRoutingPartitionV2,
} from '../spatial/v2/routingPlan';
import {
  NonDestructiveSpatialTapRegistry,
} from '../spatial/v2/nonDestructiveTap';

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

  /** Setzt das Ausgabe-Layout.
   *  - stereo/2.0 → Stereo
   *  - 2.1        → L/R/LFE (Crossover)
   *  - alle Layouts aus `src/core/spatial/layouts.ts` → Mehrkanal-Bus mit
   *    routingPlan-gesteuerten Gewichten (SP-P0-02)
   *  - spatial-tap-Routing umgeht den direkten Master-Summe-Effekt (SP-P0-02)
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
      // SP-P0-02: Erst routingPlan erstellen, dann Tap-Registry verwenden
      const routingPlan = createSpatialRoutingPlanV2(id);
      verifySpatialRoutingPartitionV2(routingPlan);
      const multi = new MultichannelBusNode('v2out:spatial', count);
      // Initiale Gewichte aus dem routingPlan; kann später per
      // setSpatialWeights/NonDestructiveSpatialTapRegistry überschrieben werden
      multi.setChannelGains(routingPlan.initialGains);
      this.outputNode = multi;

      // SP-P0-02: NonDestructive Tap Registry für post-fader Source-Taps einrichten
      const tapRegistry = new NonDestructiveSpatialTapRegistry(count);
      this.graph.register(tapRegistry);
    }
    this.graph.addNode(this.outputNode);
    this.graph.connect(this.source.outputs[0], this.outputNode.inputs[0]);
  }

  /** Setzt die Kanal-Gewichte eines Spatial-Busses (SP-P0-02).
   *  Nimmt VBAP/Routing-Gewichte vom routingPlan entgegen oder setzt
   *  neue Werte, die über die NonDestructiveSpatialTapRegistry geleitet werden.
   */
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