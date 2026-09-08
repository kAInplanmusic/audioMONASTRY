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

  /** Startet den sample-genauen V2-Transport (AudioWorklet-Step-Scheduler). */
  startTransport(config: { bpm?: number; swing?: number; gate?: number; stepCount?: 16 | 32 } = {}): boolean {
    return this.post({
      type: 'transport',
      playing: true,
      bpm: config.bpm,
      swing: config.swing,
      gate: config.gate,
      stepCount: config.stepCount,
    });
  }

  /** Stoppt den V2-Transport. */
  stopTransport(): boolean {
    return this.post({ type: 'transport', playing: false });
  }

  /** Aktualisiert laufende Transport-Parameter, ohne den Transport neu zu starten. */
  updateTransport(config: { bpm?: number; swing?: number; gate?: number; stepCount?: 16 | 32 } = {}): boolean {
    return this.post({
      type: 'transport',
      bpm: config.bpm,
      swing: config.swing,
      gate: config.gate,
      stepCount: config.stepCount,
    });
  }

  /** Setzt ein Step-Pattern (boolean[]) für einen V2-Kanal im Worklet. */
  setPattern(channel: V2Channel, steps: boolean[]): boolean {
    if (!Array.isArray(steps) || (steps.length !== 16 && steps.length !== 32)) return false;
    return this.post({ type: 'pattern', channel, steps: [...steps] });
  }

  /** Lädt eine Sample-Quelle in den V2-Sink (Sample-Player als V2-Source). */
  setSampleBuffer(channel: V2Channel, left: Float32Array, right?: Float32Array | null, sourceRate = 48000): boolean {
    if (!left || left.length === 0) return false;
    return this.post({ type: 'sample-set', channel, left, right: right ?? null, sourceRate });
  }

  /** Triggert die Sample-Wiedergabe eines Kanals im V2-Sink. */
  triggerSample(channel: V2Channel, options: { loop?: boolean; rate?: number; offset?: number } = {}): boolean {
    return this.post({
      type: 'sample-trigger',
      channel,
      loop: options.loop,
      rate: options.rate,
      offset: options.offset,
    });
  }

  /** Stoppt die Sample-Wiedergabe eines Kanals im V2-Sink. */
  stopSample(channel: V2Channel): boolean {
    return this.post({ type: 'sample-stop', channel });
  }

  /** Registriert eine Synth-/Step-Quelle für einen V2-Kanal. */
  setSynthSource(channel: V2Channel, freq: number): boolean {
    if (!Number.isFinite(freq) || freq <= 0) return false;
    return this.post({ type: 'synth-source', channel, freq });
  }

  /** Lädt eine SFZ-Instrument-Definition als V2-Quelle auf einen Kanal. */
  loadSfzBank(channel: V2Channel, sfzText: string, sources: Record<string, Float32Array>): boolean {
    if (!sfzText) return false;
    return this.post({ type: 'sfz-load', channel, sfzText, sources });
  }

  /** SFZ-Note-On an die V2-Quelle des Kanals senden. */
  sfzNoteOn(channel: V2Channel, note: number, velocity = 100): boolean {
    if (!Number.isFinite(note)) return false;
    return this.post({ type: 'sfz-note-on', channel, note, velocity });
  }

  /** SFZ-Note-Off an die V2-Quelle des Kanals senden. */
  sfzNoteOff(channel: V2Channel, note: number): boolean {
    if (!Number.isFinite(note)) return false;
    return this.post({ type: 'sfz-note-off', channel, note });
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
