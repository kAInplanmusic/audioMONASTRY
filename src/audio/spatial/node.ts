/**
 * spatialMONK – Main-Thread-Wrapper + Adapter (WhitePaper Abschnitt 3/5/10)
 * ========================================================================
 * - SpatialNode: ein spatial-processor AudioWorkletNode (maxSources Eingänge)
 * - SpatialCluster: mehrere Instanzen, Round-Robin-Verteilung, Auto-Split
 *   bei CPU-Schwellwert, manueller Split, Metriken-Aggregation
 * - spatialAdapter: übersetzt alte spatial-Message-/API-Formate auf das neue
 *   Kommando-Protokoll (schrittweises Rollout, alte UIs/Automationen laufen weiter)
 */
import type { SpatialSource, TrackType } from '../../types';
import { compileHrtfConvWasm } from './wasmHrtf';

export type SpatialQuality = 'low' | 'medium' | 'high';

export interface SpatialMetrics {
  cpuEstimate: number;
  activeSources: number;
  quality: SpatialQuality;
}

export interface SpatialNodeOptions {
  maxSources?: number;
  autoSplitCpuThreshold?: number;
  onMetrics?: (metrics: SpatialMetrics) => void;
}

const WORKLET_URL = '/worklets/spatialProcessor.js';
const PROCESSOR_NAME = 'spatial-processor';

let modulePromise: Promise<void> | null = null;

export async function ensureSpatialProcessorModule(ctx: BaseAudioContext): Promise<void> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const aw = (ctx as any).audioWorklet;
      if (!aw || typeof aw.addModule !== 'function') {
        throw new Error('AudioWorklet nicht verfügbar');
      }
      try {
        new AudioWorkletNode(ctx, PROCESSOR_NAME);
      } catch {
        await aw.addModule(WORKLET_URL);
      }
    })();
  }
  await modulePromise;
}

export class SpatialNode {
  readonly ctx: BaseAudioContext;
  readonly node: AudioWorkletNode;
  readonly maxSources: number;
  readonly slotTaken: boolean[] = [];
  readonly sources = new Map<number, { source: SpatialSource; slot: number }>();
  private inputGains: GainNode[] = [];

  private constructor(ctx: BaseAudioContext, node: AudioWorkletNode, maxSources: number) {
    this.ctx = ctx;
    this.node = node;
    this.maxSources = maxSources;
    for (let i = 0; i < maxSources; i++) this.slotTaken.push(false);
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m?.cmd === 'metrics') {
        this.onMetrics?.({
          cpuEstimate: Number(m.cpuEstimate) || 0,
          activeSources: Number(m.activeSources) || 0,
          quality: m.quality ?? 'low',
        });
      }
    };
  }

  onMetrics: ((metrics: SpatialMetrics) => void) | null = null;

  static async create(ctx: BaseAudioContext, options: SpatialNodeOptions = {}): Promise<SpatialNode> {
    await ensureSpatialProcessorModule(ctx);
    const maxSources = Math.max(1, Math.min(32, options.maxSources ?? 8));
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: maxSources,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    const instance = new SpatialNode(ctx, node, maxSources);
    return instance;
  }

  connect(destination: AudioNode): void {
    this.node.connect(destination);
  }

  disconnect(): void {
    try { this.node.disconnect(); } catch { /* noop */ }
  }

  /** Lädt HRTF-Kernel (JSON {left:[], right:[]}) und überträgt sie ins Worklet. */
  async loadHrtf(url: string): Promise<boolean> {
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const data = await res.json();
      if (!Array.isArray(data?.left) || !Array.isArray(data?.right)) return false;
      this.node.port.postMessage({ cmd: 'loadHRTF', left: data.left, right: data.right });
      return true;
    } catch {
      return false;
    }
  }

  /** Kompiliert das WASM-partitioned-FFT-Modul und übergibt es dem Worklet. */
  async loadHrtfWasm(url: string): Promise<boolean> {
    try {
      const module = await compileHrtfConvWasm(url);
      this.node.port.postMessage({ cmd: 'loadHRTFWasm', module });
      return true;
    } catch {
      return false;
    }
  }

  freeSlot(): number {
    const idx = this.slotTaken.indexOf(false);
    return idx;
  }

  /** Liefert den Eingangs-Gain für Slot `slot` (Quelle kabelt hier ihr Signal an). */
  sourceInput(slot: number): GainNode {
    if (!this.inputGains[slot]) {
      const g = this.ctx.createGain();
      g.gain.value = 1;
      g.connect(this.node, 0, slot);
      this.inputGains[slot] = g;
    }
    return this.inputGains[slot];
  }

  addSource(source: SpatialSource, slot: number): void {
    if (slot < 0 || slot >= this.maxSources) return;
    this.slotTaken[slot] = true;
    this.sources.set(source.id, { source, slot });
    this.node.port.postMessage({
      cmd: 'addSource',
      id: source.id,
      az: source.az,
      el: source.el,
      dist: source.dist,
      gain: source.gain,
      name: source.name,
    });
  }

  removeSource(id: number): void {
    const entry = this.sources.get(id);
    if (!entry) return;
    this.slotTaken[entry.slot] = false;
    this.sources.delete(id);
    this.node.port.postMessage({ cmd: 'removeSource', id });
  }

  setSourcePos(id: number, patch: Partial<SpatialSource>, rampTimeMs = 30): void {
    if (!this.sources.has(id)) return;
    this.node.port.postMessage({ cmd: 'setPos', id, rampTime: rampTimeMs, ...patch });
  }

  setGlobal(quality: SpatialQuality, listenerRot = 0, masterGain = 1): void {
    this.node.port.postMessage({ cmd: 'setGlobal', quality, listenerRot, masterGain });
  }

  requestMetrics(): void {
    this.node.port.postMessage({ cmd: 'metricsRequest' });
  }

  reset(): void {
    for (const id of [...this.sources.keys()]) this.removeSource(id);
    this.node.port.postMessage({ cmd: 'reset' });
  }

  dispose(): void {
    try { this.node.port.close(); } catch { /* noop */ }
    this.disconnect();
  }
}

export interface SpatialClusterOptions extends SpatialNodeOptions {
  maxInstances?: number;
}

/**
 * SpatialCluster – Load-Balancing über mehrere spatial-processor-Instanzen.
 * Standard: eine Instanz für maxSources Quellen. Bei CPU > Schwelle wird
 * automatisch gesplittet (Round-Robin); manueller Split jederzeit möglich.
 */
export class SpatialCluster {
  private ctx: BaseAudioContext;
  private instances: SpatialNode[] = [];
  private sourceInstance = new Map<number, SpatialNode>();
  private options: SpatialClusterOptions;
  onMetrics: ((metrics: SpatialMetrics & { instances: number }) => void) | null = null;

  private constructor(ctx: BaseAudioContext, options: SpatialClusterOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  static async create(ctx: BaseAudioContext, options: SpatialClusterOptions = {}): Promise<SpatialCluster> {
    const cluster = new SpatialCluster(ctx, options);
    await cluster.init();
    return cluster;
  }

  private async init(): Promise<void> {
    const first = await SpatialNode.create(this.ctx, this.options);
    first.onMetrics = (m) => this.handleMetrics(first, m);
    this.instances.push(first);
  }

  get instanceCount(): number {
    return this.instances.length;
  }

  get totalActiveSources(): number {
    return this.sourceInstance.size;
  }

  private handleMetrics(node: SpatialNode, metrics: SpatialMetrics): void {
    const threshold = this.options.autoSplitCpuThreshold ?? 0.65;
    const maxInstances = this.options.maxInstances ?? 4;
    if (metrics.cpuEstimate > threshold && this.instances.length < maxInstances && this.totalActiveSources > 1) {
      void this.splitNow();
    }
    this.onMetrics?.({ ...metrics, instances: this.instances.length });
  }

  private pickNode(): SpatialNode {
    let best = this.instances[0];
    for (const inst of this.instances) {
      if (inst.sources.size < best.sources.size) best = inst;
    }
    if (best.sources.size < best.maxSources) return best;
    return best;
  }

  /** Manueller Split: neue Instanz erzeugen, Quellen gleichmäßig verteilen. */
  async splitNow(): Promise<number> {
    const maxInstances = this.options.maxInstances ?? 4;
    if (this.instances.length >= maxInstances) return this.instances.length;
    const next = await SpatialNode.create(this.ctx, { maxSources: this.options.maxSources ?? 8 });
    next.onMetrics = (m) => this.handleMetrics(next, m);
    this.instances.push(next);

    const all = [...this.sourceInstance.entries()];
    const targetSize = Math.ceil(all.length / this.instances.length);
    all.forEach(([id, node], idx) => {
      const dest = this.instances[idx % this.instances.length];
      if (dest !== node) {
        const entry = node.sources.get(id);
        if (!entry) return;
        const slot = dest.freeSlot();
        if (slot < 0) return;
        node.removeSource(id);
        dest.addSource(entry.source, slot);
        this.sourceInstance.set(id, dest);
      }
    });
    // Gleichverteilung erzwingen (best effort, überzählige auf frühere Instanzen)
    const sizes = this.instances.map((i) => i.sources.size);
    let guard = 0;
    while (guard++ < 200) {
      let from = -1; let to = -1;
      for (let i = 0; i < sizes.length; i++) {
        if (sizes[i] > targetSize) from = i;
      }
      if (from < 0) break;
      for (let i = 0; i < sizes.length; i++) {
        if (sizes[i] < targetSize) { to = i; break; }
      }
      if (to < 0) break;
      const donor = this.instances[from];
      const receiver = this.instances[to];
      const firstId = donor.sources.keys().next().value;
      if (firstId === undefined) break;
      const entry = donor.sources.get(firstId);
      const slot = receiver.freeSlot();
      if (!entry || slot < 0) break;
      donor.removeSource(firstId);
      receiver.addSource(entry.source, slot);
      this.sourceInstance.set(firstId, receiver);
      sizes[from] -= 1; sizes[to] += 1;
    }
    return this.instances.length;
  }

  addSource(source: SpatialSource): GainNode | null {
    const node = this.pickNode();
    const slot = node.freeSlot();
    if (slot < 0) return null;
    node.addSource(source, slot);
    this.sourceInstance.set(source.id, node);
    return node.sourceInput(slot);
  }

  sourceInput(id: number): GainNode | null {
    const node = this.sourceInstance.get(id);
    if (!node) return null;
    const entry = node.sources.get(id);
    return entry ? node.sourceInput(entry.slot) : null;
  }

  removeSource(id: number): void {
    const node = this.sourceInstance.get(id);
    if (!node) return;
    node.removeSource(id);
    this.sourceInstance.delete(id);
  }

  setSourcePos(id: number, patch: Partial<SpatialSource>, rampTimeMs = 30): void {
    const node = this.sourceInstance.get(id);
    if (!node) return;
    node.setSourcePos(id, patch, rampTimeMs);
  }

  setGlobal(quality: SpatialQuality, listenerRot = 0, masterGain = 1): void {
    for (const inst of this.instances) inst.setGlobal(quality, listenerRot, masterGain);
  }

  requestMetrics(): void {
    for (const inst of this.instances) inst.requestMetrics();
  }

  /** Verbindet alle Instanz-Ausgänge auf ein Ziel (z. B. GLOBAL_MASTER). */
  connect(destination: AudioNode): void {
    for (const inst of this.instances) inst.connect(destination);
  }

  /** Trennt alle Instanz-Ausgänge. */
  disconnect(): void {
    for (const inst of this.instances) inst.disconnect();
  }

  /** Lädt HRTF-Kernel auf alle Instanzen. */
  async loadHrtf(url: string): Promise<boolean> {
    const results = await Promise.all(this.instances.map((i) => i.loadHrtf(url)));
    return results.some(Boolean);
  }

  /** Lädt das WASM-HRTF-Modul auf alle Instanzen. */
  async loadHrtfWasm(url: string): Promise<boolean> {
    const results = await Promise.all(this.instances.map((i) => i.loadHrtfWasm(url)));
    return results.some(Boolean);
  }

  /** Setzt alle Instanzen zurück (Quellen entfernt, DSP-State geleert). */
  reset(): void {
    for (const inst of this.instances) inst.reset();
    this.sourceInstance.clear();
  }

  dispose(): void {
    for (const inst of this.instances) inst.dispose();
    this.instances = [];
    this.sourceInstance.clear();
  }
}

/** Übersetzt alte spatial-Message-Formate auf das neue Kommando-Protokoll. */
export function translateLegacySpatialMessage(msg: any): any | null {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.cmd) return msg; // bereits neues Format
  const type = String(msg.type ?? '');
  if (type === 'spatial:set' || type === 'spatial:position') {
    const az = typeof msg.az === 'number' ? msg.az : typeof msg.x === 'number' ? msg.x * 90 : 0;
    return { cmd: 'setPos', id: msg.id ?? msg.sourceId ?? 1, az, el: msg.el, dist: msg.dist, gain: msg.gain, rampTime: msg.rampTime };
  }
  if (type === 'spatial:add') {
    return { cmd: 'addSource', id: msg.id ?? Date.now(), az: msg.az ?? 0, el: msg.el ?? 0, dist: msg.dist ?? 1, gain: msg.gain ?? 1, name: msg.name };
  }
  if (type === 'spatial:remove') {
    return { cmd: 'removeSource', id: msg.id };
  }
  if (type === 'spatial:global') {
    return { cmd: 'setGlobal', quality: msg.quality, listenerRot: msg.listenerRot, masterGain: msg.masterGain };
  }
  return null;
}

/**
 * spatialAdapter – hält den Übergang von der alten audioEngine-API
 * (`setSpatialPosition(track, x, y)`) zum neuen Cluster am Leben.
 * Solange das Audio-Graph-Routing noch nicht auf die Worklet-Eingänge
 * umgestellt ist, wird zusätzlich die bestehende Engine-Position gesetzt
 * (Fallback-Pfad, schrittweises Rollout laut WhitePaper Abschnitt 10).
 */
export const spatialAdapter = {
  cluster: null as SpatialCluster | null,
  trackSourceIds: {} as Record<TrackType, number>,

  attach(cluster: SpatialCluster): void {
    this.cluster = cluster;
  },

  ensureTrackSource(track: TrackType, name: string): number {
    if (this.trackSourceIds[track]) return this.trackSourceIds[track];
    const id = Number(track.replace('channel', '')) || 1;
    this.trackSourceIds[track] = id;
    this.cluster?.addSource({ id, name, az: 0, el: 0, dist: 1.2, gain: 0.9, muted: false, track });
    return id;
  },

  applyLegacyPosition(track: TrackType, x: number, y: number, name = track): void {
    if (!this.cluster) return;
    const id = this.ensureTrackSource(track, name);
    const az = Math.max(-180, Math.min(180, x * 90));
    const dist = Math.max(0.2, Math.min(4, 1.2 - y * 0.6));
    this.cluster.setSourcePos(id, { az, dist }, 40);
  },
};
