/**
 * audioMONASTRY · Phase 1, Schritt 1 – GraphStateBridge
 * ======================================================
 * Hebt `AudioGraphState` (export/import) auf den backend-unabhängigen Graph.
 */
import { AudioGraph } from './AudioGraph';
import type { AudioGraphState } from '../../utils/audioGraphSerialization';
import { GainNode, StereoPanNode } from './nodes/basicNodes';

const CHANNELS = ['channel1', 'channel2', 'channel3', 'channel4', 'channel5', 'channel6', 'channel7', 'channel8'] as const;

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function linearToDb(linear: number): number {
  return 20 * Math.log10(Math.max(1e-6, linear));
}

export class GraphStateBridge {
  readonly graph = new AudioGraph();
  readonly gainNodes = new Map<string, GainNode>();
  readonly panNodes = new Map<string, StereoPanNode>();

  /** Importiert einen AudioGraphState in Gain-/Pan-Nodes (Mixer-Kette). */
  importState(state: AudioGraphState): void {
    for (const track of CHANNELS) {
      let gain = this.gainNodes.get(track);
      if (!gain) {
        gain = new GainNode(`gain:${track}`, 1);
        this.gainNodes.set(track, gain);
        this.graph.addNode(gain);
      }
      gain.gain.setValue(dbToLinear(state.channelGainsDb[track] ?? 0));

      let pan = this.panNodes.get(track);
      if (!pan) {
        pan = new StereoPanNode(`pan:${track}`, 0);
        this.panNodes.set(track, pan);
        this.graph.addNode(pan);
        this.graph.connect(gain.outputs[0], pan.inputs[0]);
      }
      pan.pan.setValue(state.channelPans[track] ?? 0);
    }
    this.graph.compile();
  }

  /** Liest die aktuelle Gain-/Pan-Konfiguration aus dem Graph zurück. */
  exportState(base: Omit<AudioGraphState, 'channelGainsDb' | 'channelPans'>): AudioGraphState {
    const channelGainsDb: Record<string, number> = {};
    const channelPans: Record<string, number> = {};
    for (const track of CHANNELS) {
      const gain = this.gainNodes.get(track);
      const pan = this.panNodes.get(track);
      channelGainsDb[track] = gain ? linearToDb(gain.gain.value) : 0;
      channelPans[track] = pan ? pan.pan.value : 0;
    }
    return { ...base, channelGainsDb, channelPans };
  }
}
