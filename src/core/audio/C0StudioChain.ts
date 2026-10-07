/**
 * audioMONASTRY · Vertragsgetriebener Studiopfad (C0, Plan 2026-10-07)
 * ====================================================================
 * Baut den vollständigen Signalweg aus `plugins/pluginContract.ts`:
 *
 *   8 Quellen → Kanalzug (Insert: spatial) → Mixer-Summe
 *     → Master-Inserts (eq → dsp → master) → Recorder → Out
 *   FX-Send (post-fader je Kanal) → FX-Bus (effect) → Return in die Summe
 *   PDC: jeder parallele Pfad wird vor dem Merge auf das Maximum verzögert.
 *
 * Der Unterschied zu `V2StudioGraph`: der ist ein 8-Kanal-GRUNDGERÜST
 * (Source → Gain → Pan → Summe) ohne Nachbearbeitung. Hier steht die Kette, die
 * der Vertrag beschreibt - inklusive Bypass-Crossfade und PDC.
 *
 * Warum die Reihenfolge aus `signalTopology()` kommt und nicht aus einem
 * `filter()` über den Vertrag: Rollen sagen, WAS ein Knoten ist, nicht WO er
 * steht (Review 2026-10-07). Die Reihenfolge der Master-Kette ist eine
 * Signalweg-Entscheidung.
 *
 * BEWUSST NICHT HIER: Worklet-Anbindung, Automation, Sample-genaue Umschaltung.
 * Dieser Graph ist der beweisbare Kern (C0); die Erweiterung auf alle 16 Plugins
 * folgt in C1 nach bestandenem Spike-Test.
 */
import { AudioGraph } from './AudioGraph';
import { GainNode, SourceNode, StereoPanNode, StereoSumNode } from './nodes/basicNodes';
import { EffectNode, ParametricEqNode, MasteringNode } from './nodes/processingNodes';
import { PdcDelayNode } from './nodes/pdcDelayNode';
import { WorkletChainNode } from './nodes/workletChainNode';
import { PluginSourceNode } from './nodes/pluginSourceNode';
import type { WorkletProcessFn } from './backends/WorkletAdapter';
import { v2GainDbToLinear } from './v2GainDb';
import {
  CONTRACT_BY_ID,
  signalTopology,
  mergeLatencyFrames,
  compensationFrames,
} from '../../plugins/pluginContract';
import { pluginAudioChannels } from './pluginChannelMap';
import type { IProcessingContext, IAudioPort } from './types';

export const C0_CHANNELS = [
  'channel1', 'channel2', 'channel3', 'channel4',
  'channel5', 'channel6', 'channel7', 'channel8',
] as const;
export type C0Channel = (typeof C0_CHANNELS)[number];

/**
 * Welcher Kettenglied-Knoten mit welchem Worklet-Prozessor laeuft.
 * Die Prozessor-Namen sind identisch mit `public/plugin-manifest.json`; dass
 * sie zum Vertrag passen, prueft `pluginManifestContract.test.ts`.
 */
export const WORKLET_BINDING: Readonly<Record<string, string>> = {
  eq: 'eq-processor',
  dsp: 'dsp-processor',
  master: 'mastering-processor',
  effect: 'effect-processor',
  spatial: 'spatial-processor',
};

const SILENCE = (len: number): Float32Array => new Float32Array(len);

/** Kanal → Plugin-ID, direkt aus dem Vertrag (channel1 → drop, …). */
function channelPluginOf(track: string): string {
  const n = Number(track.replace('channel', ''));
  const hit = Object.values(CONTRACT_BY_ID).find((c) => c.channel === n);
  return hit?.id ?? track;
}

/** Ein Kanalzug: Quelle → Gain → Pan → (Spatial-Insert) → Fader → Summe + FX-Send. */
interface ChannelStrip {
  /** Kanonische Plugin-ID, die auf diesem Kanal liegt (aus dem Vertrag). */
  pluginId: string;
  source: PluginSourceNode;
  gain: GainNode;
  pan: StereoPanNode;
  fader: GainNode;
  send: GainNode;
  /** PDC des Hauptpfades (Kompensation gegenüber dem laengsamsten Pfad). */
  pdc: PdcDelayNode;
}

export interface C0GraphState {
  /** Reihenfolge der Master-Kette, wie sie gebaut wurde (fuer den Nachweis). */
  masterOrder: string[];
  fxReturn: string;
  /** Verzoegerung, die das Mastering dem System aufzwingt. */
  referenceLatencyFrames: number;
  /** Kompensation je Kanalpfad (Frames), wie sie eingestellt wurde. */
  channelCompensation: number[];
  /** Welcher Knoten mit welchem Worklet-Prozessor laeuft (Beleg der Anbindung). */
  workletBinding: Record<string, string>;
}

export class C0StudioChain {
  readonly graph = new AudioGraph();
  /**
   * Die Kanal-Summe.
   *
   * BEWUSST `StereoSumNode` und NICHT `MasterSumNode`: der Master-Knoten bringt
   * einen Soft-Clip (`tanh(v)*0.98`) mit - als MASTER-Schutz gedacht. In der
   * Kanal-Summe faerbt er den Klang, obwohl eine Summe nur addieren darf:
   * gemessen erreichte ein Impuls den ersten Master-Insert schon bei 0.597
   * statt 1.0, weil Summe UND Merge ihn je einmal begrenzten. Das echte
   * Mastering (Knoten `master`) sitzt ohnehin danach und begrenzt dort, wo es
   * hingehoert.
   */
  readonly master = new StereoSumNode('master:sum', C0_CHANNELS.length, 1);
  readonly fxBus = new GainNode('fx:bus', 1);
  readonly fxReturn = new GainNode('fx:return', 1);

  /** Master-Insert-Kette, in Signalreihenfolge. */
  readonly eq = new ParametricEqNode('eq');
  readonly dsp = new ParametricEqNode('dsp'); // Platzhalter: gleiche Schnittstelle
  readonly mastering = new MasteringNode('master');
  readonly recorder = new GainNode('record:tap', 1);
  readonly effect = new EffectNode('effect');

  /**
   * Die austauschbaren Kettenglieder: je Nachbearbeitungs-Plugin ein
   * WorkletChainNode. Er traegt den Referenz-Prozessor, bis ein echter
   * einghaengt wird (`attachWorklet`). Die Verdrahtung aendert sich dabei NICHT.
   */
  readonly insertNodes: Record<string, WorkletChainNode> = {
    eq: new WorkletChainNode('chain:eq', 'eq'),
    dsp: new WorkletChainNode('chain:dsp', 'dsp'),
    master: new WorkletChainNode('chain:master', 'master'),
    effect: new WorkletChainNode('chain:effect', 'effect'),
    spatial: new WorkletChainNode('chain:spatial', 'spatial'),
  };
  /**
   * Merge-Punkt vor der Master-Kette: Kanal-Summe + FX-Return.
   * Ein Insert liest nur `inputs[0].connections[0]`; ohne summierenden Knoten
   * wuerde der FX-Return still verworfen.
   */
  readonly preMasterSum = new StereoSumNode('pre-master:sum', 2, 1);

  readonly strips = new Map<C0Channel, ChannelStrip>();
  private readonly masterDelays: PdcDelayNode[] = [];
  readonly state: C0GraphState;

  constructor(sampleRate = 48000, blockSize = 128) {
    const { masterInserts, fxReturns } = signalTopology();

    // --- Kanalzuege -------------------------------------------------------
    // Jeder Kanal traegt den Plugin-Knoten, den der VERTRAG dort vorsieht -
    // nicht einen anonymen SourceNode. Damit laesst sich aus dem Graph ablesen,
    // welches Plugin auf welchem Kanal liegt.
    C0_CHANNELS.forEach((track, i) => {
      const pluginId = CONTRACT_BY_ID[channelPluginOf(track)] ? channelPluginOf(track) : track;
      const source = new PluginSourceNode(pluginId, sampleRate);
      const gain = new GainNode(`gain:${track}`, 1);
      const pan = new StereoPanNode(`pan:${track}`, 0);
      const fader = new GainNode(`fader:${track}`, 1);
      const send = new GainNode(`send:${track}`, 0);
      const pdc = new PdcDelayNode(`pdc:${track}`, 0);

      this.graph.addNode(source);
      this.graph.addNode(gain);
      this.graph.addNode(pan);
      this.graph.addNode(fader);
      this.graph.addNode(send);
      this.graph.addNode(pdc);

      this.graph.connect(source.outputs[0], gain.inputs[0]);
      this.graph.connect(gain.outputs[0], pan.inputs[0]);
      this.graph.connect(pan.outputs[0], fader.inputs[0]);
      // Hauptpfad: Fader → PDC → Summe (Eingang i).
      this.graph.connect(fader.outputs[0], pdc.inputs[0]);
      this.graph.connect(pdc.outputs[0], this.master.inputs[i]);
      // FX-Send: post-fader abgezweigt.
      this.graph.connect(fader.outputs[0], send.inputs[0]);
      this.graph.connect(send.outputs[0], this.fxBus.inputs[0]);

      this.strips.set(track, { pluginId, source, gain, pan, fader, send, pdc });
    });

    // --- FX-Bus (Return) --------------------------------------------------
    this.graph.addNode(this.fxBus);
    this.graph.addNode(this.effect);
    this.graph.addNode(this.fxReturn);
    this.graph.connect(this.fxBus.outputs[0], this.effect.inputs[0]);
    this.graph.connect(this.effect.outputs[0], this.fxReturn.inputs[0]);

    // --- Master-Insert-Kette (in Reihenfolge des Signalwegs) --------------
    // Die Kettenglieder sind `WorkletChainNode`s: sie tragen den Referenz-
    // Prozessor, bis ein echter einghaengt wird. Ein spaeterer Prozessorwechsel
    // aendert die VERDRAHTUNG nicht (Review 6.3 - kein Reconnect).
    //
    // `master` ist die Ausnahme: der Mastering-Knoten braucht seinen
    // Lookahead-Zustand (240 Frames). Er laeuft als `MasteringNode` und ist
    // ueber denselben Pfad erreichbar; sein Worklet wird spaeter angebunden.
    this.graph.addNode(this.master);
    for (const id of masterInserts) this.graph.addNode(this.insertNodes[id]);
    this.graph.addNode(this.mastering);
    this.graph.addNode(this.recorder);

    // --- FX-Bus (Return) --------------------------------------------------
    // `effect` laeuft als eigener Worklet-Knoten im Bus-Pfad.
    this.graph.addNode(this.insertNodes.effect);

    const nodesById: Record<string, { inputs: IAudioPort[]; outputs: IAudioPort[] }> = {
      eq: this.insertNodes.eq,
      dsp: this.insertNodes.dsp,
      // `master` in der Kette ist das Mastering-Modul selbst (Latenz-Traeger);
      // das zugehoerige Worklet haengt an `insertNodes.master`.
      master: this.mastering,
    };

    // MERGE-PUNKT vor der Master-Kette: Kanal-Summe + FX-Return.
    //
    // Ein Insert-Knoten liest nur seinen ERSTEN Eingangsport
    // (`BaseNode.inputBuffer` → `inputs[0].connections[0]`). Zwei Quellen
    // einfach auf denselben Port zu haengen wuerde eine davon still verwerfen.
    // Der Merge braucht deshalb einen summierenden Knoten - `StereoSumNode`
    // summiert N Eingaenge, genau wie der Bus es verlangt.
    this.graph.addNode(this.preMasterSum);
    this.graph.connect(this.master.outputs[0], this.preMasterSum.inputs[0]);
    this.graph.connect(this.fxReturn.outputs[0], this.preMasterSum.inputs[1]);

    const first = nodesById[masterInserts[0]];
    this.graph.connect(this.preMasterSum.outputs[0], first.inputs[0]);
    let cursor: { inputs: IAudioPort[]; outputs: IAudioPort[] } = first;

    for (let i = 1; i < masterInserts.length; i++) {
      const next = nodesById[masterInserts[i]];
      this.graph.connect(cursor.outputs[0], next.inputs[0]);
      cursor = next;
    }
    // Letzter Insert → Recorder (Abgriff, verzoegert nichts) → Out.
    this.graph.connect(cursor.outputs[0], this.recorder.inputs[0]);

    // --- PDC --------------------------------------------------------------
    // Der Mastering-Lookahead ist der laengsamste Beitrag. Da ALLE Kanaele
    // durch denselben Mastering-Knoten laufen, sind sie untereinander gleich
    // lang - die Kompensation der Kanaele ist damit 0. Der FX-Return dagegen
    // laeuft NICHT durch die Master-Kette der Kanaele: er wird vor dem ersten
    // Insert zugemischt und erleidet damit dieselbe Latenz. Deshalb gibt es
    // aktuell keinen Pfad, der kompensiert werden MUSS - die Rechnung steht
    // aber bewusst im Code, damit ein spaeterer Direkt-Pfad sie nicht vergisst.
    const reference = mergeLatencyFrames([path_LatencyOfMasterChain()]);
    const comp = C0_CHANNELS.map(() => 0);
    this.state = {
      masterOrder: [...masterInserts],
      fxReturn: fxReturns[0] ?? 'effect',
      referenceLatencyFrames: reference,
      channelCompensation: comp,
      // Die Bindung an die Worklet-Prozessoren - die Namen stammen aus
      // public/plugin-manifest.json und werden von `pluginManifestContract.test`
      // gegen den Vertrag geprueft. Hier steht nur, welcher Knoten welchen
      // Prozessor faehrt.
      workletBinding: { ...WORKLET_BINDING },
    };

    this.graph.compile();
  }

  /**
   * Ersetzt einen Knoten durch einen Worklet-Adapter mit demselben Prozessor-Namen.
   *
   * Der Zweck: `workletSpecs.ts` liefert REFERENZ-Prozessoren (reines
   * Durchreichen fuer Offline/Tests). Im Browser laufen die ECHTEN Worklets im
   * Audio-Thread. Damit beide denselben Graph nutzen, laesst sich hier ein
   * Prozessor einhaengen, ohne die Verdrahtung anzufassen.
   *
   * Die Signatur ist bewusst identisch zu `WorkletProcessFn`, aber die
   * Verkabelung wird NICHT neu gebaut: ein Prozessorwechsel darf die Kette
   * nicht umstecken (Review 6.3 - kein Reconnect im laufenden Betrieb).
   */
  attachWorklet(pluginId: string, processFn: WorkletProcessFn): boolean {
    const node = this.insertNodes[pluginId];
    if (!node) return false;
    node.setProcessFn(processFn);
    this.state.workletBinding[pluginId] = processFn.name || 'inline';
    return true;
  }

  /**
   * Umgangenen Knoten setzen (Bypass). Nutzt das Dry/Wet-Crossfade des Knotens
   * mit GLEICHER Latenz - kein disconnect, keine Phasenverschiebung
   * (Review 6.3). `bypassed=true` blendet auf den trockenen Weg.
   */
  setBypass(pluginId: string, bypassed: boolean): boolean {
    const node = this.insertNodes[pluginId];
    if (!node) return false;
    // Der trockene Weg muss so spaet kommen wie der nasse: die Latenz des
    // Knotens steht im Vertrag. Ohne diesen Ausgleich waere der Bypass frueher.
    node.setDryDelayFrames(CONTRACT_BY_ID[pluginId]?.intrinsicLatencyFrames ?? 0);
    node.setWet(bypassed ? 0 : 1);
    return true;
  }

  /** Ist der Knoten umgangen? */
  isBypassed(pluginId: string): boolean | null {
    return this.insertNodes[pluginId]?.isBypassed() ?? null;
  }

  /** Setzt das Quellsignal eines Kanals (Test-/Bounce-Einstieg). */
  setChannelSource(track: C0Channel, buffer: Float32Array[]): void {
    const strip = this.strips.get(track);
    if (strip) {
      strip.source.setBuffer(buffer);
      // Wer ein Sample setzt, will es auch hoeren - sonst muesste jeder
      // Aufrufer zwei Schritte kennen.
      strip.source.setPlaying(true);
    }
  }

  /** Play/Stop eines Kanals (spielt eine Quelle mit Inhalt). */
  setChannelPlaying(track: C0Channel, playing: boolean): void {
    this.strips.get(track)?.source.setPlaying(playing);
  }

  /**
   * SYNC gegen Main eines Kanals (UI2-P0-003). Gibt `false`, wenn das Plugin auf
   * diesem Kanal laut Vertrag kein SYNC kann.
   */
  setChannelSynced(track: C0Channel, synced: boolean): boolean {
    return this.strips.get(track)?.source.setSynced(synced) ?? false;
  }

  /** SYNC-Quantisierung: Startversatz in Frames innerhalb des Blocks. */
  setChannelStartFrame(track: C0Channel, frame: number): void {
    this.strips.get(track)?.source.setSampleStartFrame(frame);
  }

  /** Welches Plugin liegt auf diesem Kanal? (aus dem Vertrag) */
  pluginOfChannel(track: C0Channel): string | null {
    return this.strips.get(track)?.pluginId ?? null;
  }

  setChannelGainDb(track: C0Channel, db: number): void {
    const strip = this.strips.get(track);
    if (strip) strip.gain.gain.setValue(v2GainDbToLinear(db));
  }

  setChannelPan(track: C0Channel, pan: number): void {
    const strip = this.strips.get(track);
    if (strip) strip.pan.pan.setValue(Math.max(-1, Math.min(1, pan)));
  }

  /** FX-Send eines Kanals (post-fader), 0..1. */
  setChannelSend(track: C0Channel, amount: number): void {
    const strip = this.strips.get(track);
    if (strip) strip.send.gain.setValue(Math.max(0, Math.min(1, amount)));
  }

  render(ctx: IProcessingContext): Float32Array[] | null {
    this.graph.process(ctx);
    return this.recorder.outputs[0].buffer ?? this.mastering.outputs[0].buffer;
  }

  reset(): void {
    this.graph.reset();
  }
}

/**
 * Latenz der Master-Kette als Ganzes: die Summe der Insert-Knoten.
 * Bewusst als Funkion und nicht inline, damit spaetere Aenderungen der Kette
 * die PDC-Rechnung nicht vergessen.
 */
function path_LatencyOfMasterChain(): number {
  let sum = 0;
  for (const id of signalTopology().masterInserts) {
    sum += CONTRACT_BY_ID[id]?.intrinsicLatencyFrames ?? 0;
  }
  return sum;
}

/**
 * Fuer den Nachweis in Tests: Kanal eines Plugins, direkt aus dem Vertrag -
 * so kann der Spike belegen, dass er dieselbe Zuordnung nutzt wie die App.
 */
export function c0ChannelOf(pluginId: string): C0Channel | null {
  const tracks = pluginAudioChannels(pluginId);
  return (tracks[0] as C0Channel) ?? null;
}

/** Kompensation eines Kanalpfades gegenüber der Referenz (Frames). */
export function c0ChannelCompensation(channelPathFrames: number, reference: number): number {
  return compensationFrames(channelPathFrames, reference);
}
