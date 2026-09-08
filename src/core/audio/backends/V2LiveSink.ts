/**
 * audioMONASTRY · V2LiveSink
 * ===========================
 * Browser-Adapter für den V2-Live-Output-Sink (Phase 1).
 *
 * Der Sink lädt den `v2-sink-processor` (AudioWorklet), verbindet ihn mit der
 * AudioContext-Destination und steuert den V2-Testton sowie Gain/Pan/Master
 * über Port-Nachrichten. Der eigentliche V2-Graph (`V2SinkEngine`) läuft im
 * AudioWorklet-Thread sample-genau; diese Klasse enthält nur die dünne
 * WebAudio-Verdrahtung.
 *
 * In Node/jsdom (Tests, CI) sind alle Aufrufe sichere No-Ops.
 */
import type { V2Channel } from '../V2StudioGraph';
import type { V2SinkMessage } from '../live/V2SinkEngine';

const V2_SINK_PROCESSOR_NAME = 'v2-sink-processor';
const V2_SINK_WORKLET_URL = '/worklets/v2SinkProcessor.js';

export class V2LiveSink {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;

  get isConnected(): boolean {
    return this.node !== null && this.context !== null;
  }

  /**
   * Verbindet den V2-Sink mit der AudioContext-Destination.
   * Lädt das Worklet-Modul bei Bedarf nach (idempotent).
   */
  async connect(ctx: AudioContext | null | undefined): Promise<boolean> {
    if (!ctx || typeof ctx.audioWorklet?.addModule !== 'function') return false;
    if (this.node && this.context === ctx) return true;

    this.disconnect();
    try {
      await ctx.audioWorklet.addModule(V2_SINK_WORKLET_URL);
    } catch (e) {
      console.warn(`[v2-sink] Worklet-Modul konnte nicht geladen werden (wird als bereits geladen behandelt):`, e);
    }

    try {
      const node = new AudioWorkletNode(ctx, V2_SINK_PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.connect(ctx.destination);
      this.context = ctx;
      this.node = node;
      return true;
    } catch (e) {
      console.warn('[v2-sink] V2-Live-Sink nicht verfügbar – V2 bleibt offline.', e);
      this.disconnect();
      return false;
    }
  }

  /** Trennt den Sink von der Destination (idempotent). */
  disconnect(): void {
    if (this.node) {
      try {
        this.node.port.postMessage({ type: 'test-tone', active: false } satisfies V2SinkMessage);
      } catch { /* Port nicht verfügbar */ }
      try {
        this.node.disconnect();
      } catch { /* bereits getrennt */ }
    }
    this.node = null;
    this.context = null;
  }

  /** Startet den hörbaren V2-Testton (channel1 → kompletter V2-Graph → Output). */
  startTestTone(freq = 440, amplitude = 0.2): boolean {
    return this.post({ type: 'test-tone', active: true, freq, amplitude });
  }

  /** Stoppt den V2-Testton. */
  stopTestTone(): boolean {
    return this.post({ type: 'test-tone', active: false });
  }

  /** Setzt den Kanal-Gain in dB auf der V2-Graph-Instanz im Worklet. */
  setChannelGainDb(channel: V2Channel, db: number): boolean {
    return this.post({ type: 'gain-db', channel, db });
  }

  /** Setzt das Stereo-Pan (-1..1) auf der V2-Graph-Instanz im Worklet. */
  setChannelPan(channel: V2Channel, pan: number): boolean {
    return this.post({ type: 'pan', channel, pan });
  }

  /** Setzt den Master-Gain (linear, 0..2) auf der V2-Graph-Instanz im Worklet. */
  setMasterGain(value: number): boolean {
    return this.post({ type: 'master-gain', value });
  }

  private post(message: V2SinkMessage): boolean {
    if (!this.node || typeof this.node.port?.postMessage !== 'function') return false;
    try {
      this.node.port.postMessage(message);
      return true;
    } catch (e) {
      console.warn('[v2-sink] Port-Nachricht fehlgeschlagen:', e);
      return false;
    }
  }
}
