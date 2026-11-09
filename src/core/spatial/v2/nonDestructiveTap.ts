/**
 * Separate copy-send nodes owned by spatialMONK; never disrupt a source's
 * established mixerMONK master connection. This is for WebAudio-native taps.
 * V2LiveSink sources require a dedicated V2 graph integration.
 */
type Tap = { source: AudioNode; target: AudioNode; send: GainNode };
export class NonDestructiveSpatialTapRegistry {
  private readonly taps = new Map<string, Tap>();
  constructor(private readonly context: BaseAudioContext) {}

  attach(id: string, source: AudioNode, target: AudioNode): void {
    if (!id || source === target) throw new Error('Invalid spatial proxy tap');
    const old = this.taps.get(id);
    if (old?.source === source && old?.target === target) return;
    const send = this.context.createGain();
    send.gain.value = 1;
    try {
      source.connect(send);
      send.connect(target);
    } catch (error) {
      try { source.disconnect(send); } catch { /* best effort */ }
      try { send.disconnect(); } catch { /* best effort */ }
      throw error;
    }
    this.taps.set(id, { source, target, send });
    if (old) this.release(old);
  }

  detach(id: string): void {
    const entry = this.taps.get(id);
    if (!entry) return;
    this.taps.delete(id);
    this.release(entry);
  }

  private release(entry: Tap): void {
    // Disconnect ONLY the private send. The mixer main is never touched.
    try { entry.source.disconnect(entry.send); } catch { /* already gone */ }
    try { entry.send.disconnect(); } catch { /* already gone */ }
  }

  has(id: string): boolean { return this.taps.has(id); }
  get size(): number { return this.taps.size; }

  dispose(): void {
    for (const id of [...this.taps.keys()]) this.detach(id);
  }
}
