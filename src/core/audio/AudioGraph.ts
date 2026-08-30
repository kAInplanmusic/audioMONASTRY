import type {
  AudioPortKind,
  AutomationPoint,
  IAudioBuffer,
  IAudioGraph,
  IAudioNode,
  IAudioParameter,
  IAudioPort,
  IProcessingContext,
  ProcessingPlan,
} from './types';

let bufferCounter = 0;

/** Planarer Float32-Audio-Buffer ohne Browser-Abhängigkeit. */
export class AudioBuffer implements IAudioBuffer {
  readonly id: string;
  channelData: Float32Array[];

  constructor(
    public readonly sampleRate: number,
    public readonly length: number,
    public readonly numberOfChannels: number,
    channelData?: Float32Array[],
  ) {
    this.id = `buf-${++bufferCounter}`;
    this.channelData = channelData ?? Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
  }

  clone(): AudioBuffer {
    const copy = new AudioBuffer(this.sampleRate, this.length, this.numberOfChannels);
    for (let ch = 0; ch < this.numberOfChannels; ch++) {
      copy.channelData[ch].set(this.channelData[ch]);
    }
    return copy;
  }

  createEmpty(): AudioBuffer {
    return new AudioBuffer(this.sampleRate, this.length, this.numberOfChannels);
  }
}

export class AudioPort implements IAudioPort {
  readonly id: string;
  readonly kind: AudioPortKind;
  readonly node: IAudioNode;
  readonly connections: IAudioPort[] = [];
  buffer: Float32Array[] | null = null;

  constructor(node: IAudioNode, kind: AudioPortKind, id?: string) {
    this.node = node;
    this.kind = kind;
    this.id = id ?? `${node.id}:${kind}`;
  }

  connect(target: IAudioPort): void {
    if (target === this || this.connections.includes(target)) return;
    this.connections.push(target);
    // Rückrichtung: damit Input-Ports ihren Quell-Port lesen können.
    if (!target.connections.includes(this)) target.connections.push(this);
  }

  disconnect(target?: IAudioPort): void {
    if (!target) {
      for (const t of this.connections) {
        const i = t.connections.indexOf(this);
        if (i >= 0) t.connections.splice(i, 1);
      }
      this.connections.length = 0;
      return;
    }
    const idx = this.connections.indexOf(target);
    if (idx >= 0) this.connections.splice(idx, 1);
    const rev = target.connections.indexOf(this);
    if (rev >= 0) target.connections.splice(rev, 1);
  }
}

export class AudioParameter implements IAudioParameter {
  readonly automation: AutomationPoint[] = [];

  constructor(
    public readonly id: string,
    public readonly min: number,
    public readonly max: number,
    public readonly defaultValue: number,
  ) {
    this.value = defaultValue;
  }

  value: number;

  setValue(value: number): void {
    this.value = Math.min(this.max, Math.max(this.min, value));
  }

  setValueAtTime(value: number, time: number): void {
    this.automation.push({ time, value: Math.min(this.max, Math.max(this.min, value)) });
    this.automation.sort((a, b) => a.time - b.time);
  }

  getValueAtTime(time: number): number {
    if (this.automation.length === 0) return this.value;
    if (time <= this.automation[0].time) return this.automation[0].value;
    for (let i = 1; i < this.automation.length; i++) {
      const prev = this.automation[i - 1];
      const next = this.automation[i];
      if (time <= next.time) {
        const span = next.time - prev.time;
        if (span <= 0) return next.value;
        const t = (time - prev.time) / span;
        return prev.value + (next.value - prev.value) * t;
      }
    }
    return this.automation[this.automation.length - 1].value;
  }

  reset(): void {
    this.value = this.defaultValue;
    this.automation.length = 0;
  }
}

/**
 * Backend-unabhängiger AudioGraph.
 * Führt einen topologischen Sort durch und verarbeitet Knoten in
 * deterministischer Reihenfolge. Realtime und Offline nutzen dieselbe Struktur.
 */
export class AudioGraph implements IAudioGraph {
  private nodes = new Map<string, IAudioNode>();
  private planCache: ProcessingPlan | null = null;
  private dirty = true;

  /** Markiert den kompilierten Plan als veraltet (Topologie geändert). */
  invalidate(): void {
    this.dirty = true;
  }

  addNode(node: IAudioNode): void {
    if (this.nodes.has(node.id)) throw new Error(`Node bereits vorhanden: ${node.id}`);
    this.nodes.set(node.id, node);
    this.invalidate();
  }

  removeNode(nodeOrId: IAudioNode | string): void {
    const id = typeof nodeOrId === 'string' ? nodeOrId : nodeOrId.id;
    const node = this.nodes.get(id);
    if (!node) return;
    for (const input of node.inputs) input.disconnect();
    for (const output of node.outputs) output.disconnect();
    this.nodes.delete(id);
    this.invalidate();
  }

  connect(source: IAudioPort, target: IAudioPort): void {
    if (source.kind !== 'output') throw new Error('Quelle muss ein Output-Port sein');
    if (target.kind !== 'input') throw new Error('Ziel muss ein Input-Port sein');
    source.connect(target);
    this.invalidate();
  }

  disconnect(source: IAudioPort, target?: IAudioPort): void {
    source.disconnect(target);
    this.invalidate();
  }

  compile(): ProcessingPlan { // NOSONAR: Topologischer Sort bewusst zentral und imperativ
    if (!this.dirty && this.planCache) return this.planCache;
    const indegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of this.nodes.values()) {
      indegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    for (const node of this.nodes.values()) {
      for (const output of node.outputs) {
        for (const target of output.connections) {
          const sourceId = node.id;
          const targetId = target.node.id;
          if (sourceId === targetId) continue;
          const next = adjacency.get(sourceId) ?? [];
          if (!next.includes(targetId)) {
            next.push(targetId);
            indegree.set(targetId, (indegree.get(targetId) ?? 0) + 1);
          }
        }
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of indegree) if (deg === 0) queue.push(id);

    const order: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(id);
      for (const nextId of adjacency.get(id) ?? []) {
        const deg = (indegree.get(nextId) ?? 1) - 1;
        indegree.set(nextId, deg);
        if (deg === 0) queue.push(nextId);
      }
    }

    const validated = order.length === this.nodes.size;
    const nodes = order
      .map((id) => this.nodes.get(id))
      .filter((n): n is IAudioNode => Boolean(n));

    const plan: ProcessingPlan = { nodes, order, validated };
    this.planCache = plan;
    this.dirty = false;
    return plan;
  }

  process(ctx: IProcessingContext): void {
    const plan = this.compile();
    if (!plan.validated) throw new Error('AudioGraph enthält einen Zyklus');
    for (const node of plan.nodes) node.process(ctx);
  }

  getLastOutput(): Float32Array[] | null {
    const plan = this.compile();
    for (let i = plan.nodes.length - 1; i >= 0; i--) {
      const node = plan.nodes[i];
      const output = node.outputs[node.outputs.length - 1];
      if (output?.buffer) return output.buffer;
    }
    return null;
  }

  reset(): void {
    for (const node of this.nodes.values()) node.reset();
  }
}
