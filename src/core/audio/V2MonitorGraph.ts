/**
 * audioMONASTRY · V2MonitorGraph (Phase 4 – Cue/Main/Monitor als V2-Graph)
 * =========================================================================
 * Backend-unabhängiger Mischgraph mit allen 10 V2-Kanälen und dem lokalen
 * Abhörweg aus dem V1-Monitor-System:
 *
 *   Source ─┬→ CueGain(track) → CueBus (pre-fader, PFL)
 *           └→ Gain(dB) → StereoPan → MainBus (Master)
 *
 *   MainBus → MainMonitorGain ─┐
 *   CueBus  → CueMonitorGain  ─┴→ MonitorBus → lokaler Ausgang
 *
 * `render()` liefert den lokalen Monitor-Ausgang. Dadurch kann der V2-Live-Sink
 * dieselbe MAIN/MON/PLUGIN/MIX-Umschaltung wie V1 abbilden, ohne den MAIN-Bus
 * zu verändern. Die Klasse enthält keine WebAudio-/AudioWorklet-API.
 */
import { AudioGraph } from './AudioGraph';
import { GainNode, MasterSumNode, SourceNode, StereoPanNode, StereoSumNode } from './nodes/basicNodes';
import { V2_CHANNELS, type V2Channel } from './V2StudioGraph';
import { defaultMonitorPlan, type MonitorRoutingPlan } from './monitorRouting';
import type { IProcessingContext } from './types';

export interface V2MonitorRenderResult {
  /** Post-Fader-Master (Hauptmischung, wird durch Monitor-Wahl nicht verändert). */
  main: Float32Array[] | null;
  /** Pre-Fader-Cue-Bus (PFL-Mix des lokalen Users). */
  cue: Float32Array[] | null;
  /** Lokaler Monitor-Ausgang (MAIN, Cue/MON oder MIX). */
  monitor: Float32Array[] | null;
}

const SILENCE = (len: number): Float32Array => new Float32Array(len);

export class V2MonitorGraph {
  readonly graph = new AudioGraph();
  readonly sources = new Map<V2Channel, SourceNode>();
  readonly gains = new Map<V2Channel, GainNode>();
  readonly pans = new Map<V2Channel, StereoPanNode>();
  /** Pre-Fader-Cue-Tap-Gain je Kanal (0..2, aus MonitorRoutingPlan.cueTracks). */
  readonly cueGains = new Map<V2Channel, GainNode>();
  readonly mainBus: MasterSumNode;
  readonly cueBus: StereoSumNode;
  /** Lokaler MAIN-Abhörpegel (0/1 für MAIN/MON-Umschaltung). */
  readonly mainMonitorGainNode: GainNode;
  /** Lokaler Cue-Abhörpegel (0..1, aus MonitorRoutingPlan.cueGain). */
  readonly cueMonitorGainNode: GainNode;
  readonly monitorBus: StereoSumNode;

  private routingPlan: MonitorRoutingPlan;

  constructor(sampleRate = 48000, blockSize = 128) {
    this.routingPlan = defaultMonitorPlan('MON1');
    this.mainBus = new MasterSumNode('main:sum', V2_CHANNELS.length);
    this.cueBus = new StereoSumNode('cue:sum', V2_CHANNELS.length, 1, 2);
    this.mainMonitorGainNode = new GainNode('monitor:main-gain', 1);
    this.cueMonitorGainNode = new GainNode('monitor:cue-gain', 0);
    this.monitorBus = new StereoSumNode('monitor:sum', 2, 1, 2);

    this.graph.addNode(this.mainBus);
    this.graph.addNode(this.cueBus);
    this.graph.addNode(this.mainMonitorGainNode);
    this.graph.addNode(this.cueMonitorGainNode);
    this.graph.addNode(this.monitorBus);
    this.graph.connect(this.mainBus.outputs[0], this.mainMonitorGainNode.inputs[0]);
    this.graph.connect(this.cueBus.outputs[0], this.cueMonitorGainNode.inputs[0]);
    this.graph.connect(this.mainMonitorGainNode.outputs[0], this.monitorBus.inputs[0]);
    this.graph.connect(this.cueMonitorGainNode.outputs[0], this.monitorBus.inputs[1]);

    V2_CHANNELS.forEach((track, i) => {
      const source = new SourceNode(`source:${track}`, [SILENCE(blockSize)], sampleRate);
      const gain = new GainNode(`gain:${track}`, 1);
      const pan = new StereoPanNode(`pan:${track}`, 0);
      const cueGain = new GainNode(`cue-gain:${track}`, 1);
      this.graph.addNode(source);
      this.graph.addNode(gain);
      this.graph.addNode(pan);
      this.graph.addNode(cueGain);
      // MAIN: post-fader (Gain → Pan → MasterSum)
      this.graph.connect(source.outputs[0], gain.inputs[0]);
      this.graph.connect(gain.outputs[0], pan.inputs[0]);
      this.graph.connect(pan.outputs[0], this.mainBus.inputs[i]);
      // Cue/PFL: pre-fader parallel zum Kanalzug
      this.graph.connect(source.outputs[0], cueGain.inputs[0]);
      this.graph.connect(cueGain.outputs[0], this.cueBus.inputs[i]);
      this.sources.set(track, source);
      this.gains.set(track, gain);
      this.pans.set(track, pan);
      this.cueGains.set(track, cueGain);
    });

    this.graph.compile();
  }

  get monitorPlan(): MonitorRoutingPlan {
    return this.routingPlan;
  }

  setSourceBuffer(track: V2Channel, buffer: Float32Array[]): void {
    this.sources.get(track)!.sourceBuffer = buffer;
  }

  setGainDb(track: V2Channel, db: number): void {
    const linear = db <= -120 ? 0 : Math.pow(10, Math.max(-120, Math.min(24, db)) / 20);
    this.gains.get(track)!.gain.setValue(linear);
  }

  setPan(track: V2Channel, pan: number): void {
    this.pans.get(track)!.pan.setValue(Math.max(-1, Math.min(1, pan)));
  }

  setMasterGain(value: number): void {
    this.mainBus.masterGain.setValue(Math.max(0, Math.min(2, value)));
  }

  /** Übernimmt einen MonitorRoutingPlan (MAIN/MON/PLUGIN/MIX) in den V2-Graph. */
  applyMonitorPlan(plan: MonitorRoutingPlan): void {
    if (!plan) return;
    this.routingPlan = plan;
    this.mainMonitorGainNode.gain.setValue(plan.mainMonitorGain);
    this.cueMonitorGainNode.gain.setValue(plan.cueGain);
    for (const track of V2_CHANNELS) {
      const gain = this.cueGains.get(track);
      if (gain) gain.gain.setValue(plan.cueTracks[track] ?? 1);
    }
  }

  /** Verarbeitet den Graphen und liefert Main/Cue/Monitor-Blöcke. */
  render(ctx: IProcessingContext): V2MonitorRenderResult {
    this.graph.process(ctx);
    return {
      main: this.mainBus.outputs[0].buffer,
      cue: this.cueBus.outputs[0].buffer,
      monitor: this.monitorBus.outputs[0].buffer,
    };
  }

  /** Kompatibler Ein-Ausgangs-Render für V2SinkEngine: lokaler Monitor-Ausgang. */
  renderMonitor(ctx: IProcessingContext): Float32Array[] | null {
    return this.render(ctx).monitor;
  }

  /** Nur den MAIN-Bus rendern (z. B. Master-Stream / Offline-Bounce). */
  renderMain(ctx: IProcessingContext): Float32Array[] | null {
    this.graph.process(ctx);
    return this.mainBus.outputs[0].buffer;
  }

  /** Nur den Cue-Bus rendern (Diagnose/Tests). */
  renderCue(ctx: IProcessingContext): Float32Array[] | null {
    this.graph.process(ctx);
    return this.cueBus.outputs[0].buffer;
  }

  reset(): void {
    this.graph.reset();
    this.routingPlan = defaultMonitorPlan('MON1');
    this.mainMonitorGainNode.gain.setValue(this.routingPlan.mainMonitorGain);
    this.cueMonitorGainNode.gain.setValue(this.routingPlan.cueGain);
    for (const track of V2_CHANNELS) {
      this.cueGains.get(track)?.gain.setValue(this.routingPlan.cueTracks[track] ?? 1);
    }
  }
}
