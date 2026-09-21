/**
 * audioMONASTRY · V2StudioGraph (NEW-D4-1, „V2-Minimum hörbar“)
 * ================================================================
 * Vollständiger, backend-unabhängiger 10-Kanal-Mischpfad auf dem V2-AudioGraph:
 *   Source → Gain (dB) → StereoPan → MasterSum (Soft-Clip/NaN-Guard) → Stereo
 * Realtime (AudioWorklet-Adapter) und Offline (Tests/Bounce) nutzen dieselbe
 * Struktur. Die Engine spiegelt ihren Zustand direkt in den V2-Graph
 * (`syncV2FromV1`-Brücke in `audioEngine`).
 * Cue/Main/Monitor-Parität inkl. MonitorRoutingPlan baut `V2MonitorGraph` auf.
 */
import { AudioGraph } from './AudioGraph';
import { GainNode, MasterSumNode, SourceNode, StereoPanNode } from './nodes/basicNodes';
import { v2GainDbToLinear } from './v2GainDb';
import type { IProcessingContext } from './types';

export const V2_CHANNELS = ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8', 'channel9', 'channel10'] as const;
export type V2Channel = (typeof V2_CHANNELS)[number];

const SILENCE = (len: number): Float32Array => new Float32Array(len);

/**
 * Gemeinsamer Kanalzug von `V2StudioGraph` und `V2MonitorGraph`: beide bauen
 * dieselbe Kette (Source -> Gain (dB) -> StereoPan) auf und setzen sie ueber
 * dieselben Zugriffe. Quellen-, Gain- und Pan-Map samt Settern liegen deshalb
 * einmal hier; nur der Master-/Bus-Teil unterscheidet sich und bleibt im
 * jeweiligen Graphen.
 */
export abstract class V2ChannelStripGraph {
  readonly sources = new Map<V2Channel, SourceNode>();
  readonly gains = new Map<V2Channel, GainNode>();
  readonly pans = new Map<V2Channel, StereoPanNode>();

  setSourceBuffer(track: V2Channel, buffer: Float32Array[]): void {
    this.sources.get(track)!.sourceBuffer = buffer;
  }

  setGainDb(track: V2Channel, db: number): void {
    this.gains.get(track)!.gain.setValue(v2GainDbToLinear(db));
  }

  setPan(track: V2Channel, pan: number): void {
    this.pans.get(track)!.pan.setValue(Math.max(-1, Math.min(1, pan)));
  }
}

export class V2StudioGraph extends V2ChannelStripGraph {
  readonly graph = new AudioGraph();
  readonly master = new MasterSumNode('master:sum', V2_CHANNELS.length);

  constructor(sampleRate = 48000, blockSize = 128) {
    super();
    this.graph.addNode(this.master);
    V2_CHANNELS.forEach((track, i) => {
      const source = new SourceNode(`source:${track}`, [SILENCE(blockSize)], sampleRate);
      const gain = new GainNode(`gain:${track}`, 1);
      const pan = new StereoPanNode(`pan:${track}`, 0);
      this.graph.addNode(source);
      this.graph.addNode(gain);
      this.graph.addNode(pan);
      this.graph.connect(source.outputs[0], gain.inputs[0]);
      this.graph.connect(gain.outputs[0], pan.inputs[0]);
      this.graph.connect(pan.outputs[0], this.master.inputs[i]);
      this.sources.set(track, source);
      this.gains.set(track, gain);
      this.pans.set(track, pan);
    });
    this.graph.compile();
  }

  setMasterGain(value: number): void {
    this.master.masterGain.setValue(Math.max(0, Math.min(2, value)));
  }

  /** Rendert genau einen Block (128 Samples Stereo) durch den V2-Graph. */
  render(ctx: IProcessingContext): Float32Array[] | null {
    this.graph.process(ctx);
    return this.master.outputs[0].buffer;
  }

  reset(): void {
    this.graph.reset();
  }
}
