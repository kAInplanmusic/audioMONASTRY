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
import type { V2SinkMessage, V2SynthVoice } from '../live/V2SinkEngine';
import type { MonitorRoutingPlan } from '../monitorRouting';
import { v2OutputChannelCount } from '../V2OutputGraph';

const V2_SINK_PROCESSOR_NAME = 'v2-sink-processor';
const V2_SINK_WORKLET_URL = '/worklets/v2SinkProcessor.js';

export class V2LiveSink {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private outputLayoutId = 'stereo';

  get isConnected(): boolean {
    return this.node !== null && this.context !== null;
  }

  /** AUDIO-P0-002: Zusätzlichen Abgriff (z. B. MediaStreamDestination) am V2-Ausgang anbinden. */
  connectExtra(dest: AudioNode): boolean {
    if (!this.node || !dest || typeof dest.connect !== 'function') return false;
    try {
      this.node.connect(dest);
      return true;
    } catch (e) {
      console.warn('[v2-sink] Zusatz-Abgriff fehlgeschlagen:', e);
      return false;
    }
  }

  /** AUDIO-P0-002: Zusatz-Abgriff trennen. */
  disconnectExtra(dest: AudioNode): void {
    if (!this.node || !dest) return;
    try { this.node.disconnect(dest); } catch { /* bereits getrennt */ }
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
        outputChannelCount: [Math.max(2, Math.min(24, v2OutputChannelCount(this.outputLayoutId)))],
      });
      node.connect(ctx.destination);
      this.context = ctx;
      this.node = node;
      this.post({ type: 'output-layout', layoutId: this.outputLayoutId });
      return true;
    } catch (e) {
      console.warn('[v2-sink] V2-Live-Sink nicht verfügbar – V2 bleibt offline.', e);
      this.disconnect();
      return false;
    }
  }

  /** Phase 4: Ausgabe-Layout setzen (stereo/2.1/N.x). Wirkt live erst nach Reconnect. */
  setOutputLayout(layoutId: string): boolean {
    this.outputLayoutId = layoutId || 'stereo';
    if (this.isConnected && this.context) {
      this.disconnect();
      void this.connect(this.context); // asynchron reconnect; Fehler werden intern abgefangen
      return true;
    }
    return false;
  }

  getOutputLayout(): string {
    return this.outputLayoutId;
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

  // -------------------------------------------------------------------------
  // AUDIO-P0-004: Master-Processing (EQ/DSP/FX/Dynamics/Mastering)
  // -------------------------------------------------------------------------

  /** Master-EQ: 3-Band-Gains in dB. */
  setMasterEq(lowDb: number, midDb: number, highDb: number): boolean {
    return this.post({ type: 'master-eq', lowDb, midDb, highDb });
  }

  /** Master-DSP: dynamisches Lowpass + Drive. */
  setMasterDsp(cutoff: number, resonance: number, depth: number, drive: number): boolean {
    return this.post({ type: 'master-dsp', cutoff, resonance, depth, drive });
  }

  /** FEAT-P3-002: optionale Modulations-Matrix (LFO → Master-Gain). */
  setMasterModMatrix(enabled: boolean, rate: number, depth: number): boolean {
    return this.post({ type: 'master-mod-matrix', modEnabled: enabled, modRate: rate, modDepth: depth });
  }

  /** FEAT-P3-002: optionale HQ-Reverb (4-Leitungs-FDN) auf dem Master. */
  setMasterReverb(enabled: boolean, mix: number, decayS: number, damping: number, sizeScale = 1): boolean {
    return this.post({
      type: 'master-reverb',
      reverbEnabled: enabled,
      reverbMix: mix,
      reverbDecayS: decayS,
      reverbDamping: damping,
      reverbSizeScale: sizeScale,
    });
  }

  /** Master-FX: Reverb/Delay/Chorus-Mix. */
  setMasterFx(wet: number, feedback: number, rate: number, depth: number): boolean {
    return this.post({ type: 'master-fx', wet, feedback, rate, depth });
  }

  /** Master-Dynamics-Insert (Soft-Knee-Kompressor). */
  setMasterDynamics(enabled: boolean, threshold: number, ratio: number, makeup: number): boolean {
    return this.post({ type: 'master-dynamics', enabled, threshold, ratio, makeup });
  }

  /** Master-Mastering (Kompression + Limiter). */
  setMasterMastering(threshold: number, ratio: number, makeup: number, ceiling: number): boolean {
    return this.post({ type: 'master-mastering', threshold, ratio, makeup, ceiling });
  }

  /** Phase 4: Überträgt den lokalen MonitorRoutingPlan in den V2-Sink. */
  setMonitorRouting(plan: MonitorRoutingPlan): boolean {
    if (!plan) return false;
    return this.post({ type: 'monitor-plan', plan });
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
  setSynthSource(
    channel: V2Channel,
    freq: number,
    voice?: V2SynthVoice,
    opts: { amount?: number; modIndex?: number } = {},
  ): boolean {
    if (!Number.isFinite(freq) || freq <= 0) return false;
    return this.post({ type: 'synth-source', channel, freq, voice, amount: opts.amount, modIndex: opts.modIndex });
  }

  /** AUDIO-P0-001: Stummschaltung eines Kanals im V2-Sink. */
  setChannelMuted(channel: V2Channel, muted: boolean): boolean {
    return this.post({ type: 'mute', channel, muted });
  }

  /** AUDIO-P0-003: Manueller Synth-Trigger (Pads/Instruments) auf einem Kanal. */
  synthTrigger(channel: V2Channel, velocity = 1): boolean {
    if (!Number.isFinite(velocity)) return false;
    return this.post({ type: 'synth-trigger', channel, velocity });
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
