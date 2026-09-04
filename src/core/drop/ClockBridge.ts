/**
 * dropMONK – Clock Synchronization Bridge
 * ======================================
 * Synchronisiert Drops mit der Master-Clock (taktgenauer Recall).
 * Die App-Schicht speist updateClock() aus dem Transport/Step-Listener,
 * ohne dass der Core Plattform-APIs kennt.
 */

/**
 * Clock State
 */
export interface ClockState {
  isRunning: boolean;
  bpm: number;
  currentBeat: number; // 0..3 (in 4/4)
  currentBar: number; // Global bar counter
  sampleRate: number;
  currentSample: number;
}

/**
 * Quantization Level
 */
export type QuantizationLevel = '1beat' | '2beat' | '1bar' | '2bar' | '4bar' | '8bar';

/** Beats pro Quantisierungsraster (4/4). */
const QUANTIZATION_BEATS: Record<QuantizationLevel, number> = {
  '1beat': 1,
  '2beat': 2,
  '1bar': 4,
  '2bar': 8,
  '4bar': 16,
  '8bar': 32,
};

/**
 * Clock Synchronization Bridge
 * Schedules drops to align with bar/beat boundaries
 */
export class ClockBridge {
  private clockState: ClockState = {
    isRunning: false,
    bpm: 120,
    currentBeat: 0,
    currentBar: 0,
    sampleRate: 44100,
    currentSample: 0,
  };

  private callbacks: Map<string, (state: ClockState) => void> = new Map();
  private scheduledDrops: Array<{
    id: string;
    targetSample: number;
    callback: () => void;
  }> = [];

  /**
   * Initialize clock bridge (BPM/SampleRate vom Transport).
   */
  initialize(bpm: number, sampleRate: number): void {
    if (Number.isFinite(bpm) && bpm > 0) this.clockState.bpm = bpm;
    if (Number.isFinite(sampleRate) && sampleRate > 0) this.clockState.sampleRate = sampleRate;
  }

  /** Tempo-Änderung übernehmen. */
  setBpm(bpm: number): void {
    if (Number.isFinite(bpm) && bpm > 0) this.clockState.bpm = bpm;
  }

  /**
   * Update clock state
   * Called frequently (e.g., from audio worklet / step listener)
   */
  updateClock(currentSample: number, isRunning: boolean): void {
    this.clockState.isRunning = isRunning;
    this.clockState.currentSample = Math.max(0, currentSample);

    const samplesPerBeat = this.getSamplesPerBeat();
    const currentBeat = Math.floor(this.clockState.currentSample / samplesPerBeat);

    this.clockState.currentBeat = currentBeat % 4;
    this.clockState.currentBar = Math.floor(currentBeat / 4); // 4/4 time

    this._processScheduledDrops();
    this._broadcastClockUpdate();
  }

  /**
   * Get current clock state
   */
  getClockState(): ClockState {
    return { ...this.clockState };
  }

  /** Samples pro Beat beim aktuellen Tempo. */
  getSamplesPerBeat(): number {
    return (this.clockState.sampleRate * 60) / this.clockState.bpm;
  }

  /**
   * Get samples to next beat
   */
  getSamplesToNextBeat(): number {
    return this.getSamplesToQuantization('1beat');
  }

  /**
   * Get samples to next bar
   */
  getSamplesToNextBar(): number {
    return this.getSamplesToQuantization('1bar');
  }

  /**
   * Samples bis zum nächsten Quantisierungspunkt
   */
  getSamplesToQuantization(quantization: QuantizationLevel): number {
    const samplesPerQuantum = this.getSamplesPerBeat() * QUANTIZATION_BEATS[quantization];
    const samplesInCurrent = this.clockState.currentSample % samplesPerQuantum;
    return Math.ceil(samplesPerQuantum - samplesInCurrent);
  }

  /**
   * Verzögerung bis zum Quantisierungspunkt (Samples).
   * Beibehalten für Abwärtskompatibilität.
   */
  getDelayToQuantization(quantization: QuantizationLevel): number {
    return this.getSamplesToQuantization(quantization);
  }

  /**
   * Verzögerung bis zum Quantisierungspunkt in Millisekunden.
   */
  getDelayToQuantizationMs(quantization: QuantizationLevel): number {
    return (this.getSamplesToQuantization(quantization) / this.clockState.sampleRate) * 1000;
  }

  /**
   * Schedule a drop on next quantization point
   */
  scheduleDrop(callback: () => void, quantization: QuantizationLevel = '4bar'): string {
    const targetSample = this.clockState.currentSample + this.getSamplesToQuantization(quantization);
    const id = `drop_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    this.scheduledDrops.push({ id, targetSample, callback });
    return id;
  }

  /**
   * Cancel scheduled drop
   */
  cancelScheduledDrop(id: string): void {
    this.scheduledDrops = this.scheduledDrops.filter((d) => d.id !== id);
  }

  /** Anzahl wartender Drops (Diagnose/Tests). */
  getScheduledCount(): number {
    return this.scheduledDrops.length;
  }

  /**
   * Process scheduled drops
   */
  private _processScheduledDrops(): void {
    if (this.scheduledDrops.length === 0) return;

    const due = this.scheduledDrops.filter((d) => this.clockState.currentSample >= d.targetSample);
    if (due.length === 0) return;

    this.scheduledDrops = this.scheduledDrops.filter(
      (d) => this.clockState.currentSample < d.targetSample
    );

    for (const drop of due) {
      try {
        drop.callback();
      } catch (err) {
        console.error('[ClockBridge] scheduled drop failed:', err);
      }
    }
  }

  /**
   * Register callback for clock updates
   */
  onClockUpdate(id: string, callback: (state: ClockState) => void): void {
    this.callbacks.set(id, callback);
  }

  /**
   * Unregister callback
   */
  offClockUpdate(id: string): void {
    this.callbacks.delete(id);
  }

  /**
   * Broadcast clock update
   */
  private _broadcastClockUpdate(): void {
    if (this.callbacks.size === 0) return;
    for (const callback of this.callbacks.values()) {
      try {
        callback(this.getClockState());
      } catch (err) {
        console.error('[ClockBridge] clock listener failed:', err);
      }
    }
  }

  /** Reset (Tests/Transport-Stop). */
  reset(): void {
    this.clockState.currentSample = 0;
    this.clockState.currentBar = 0;
    this.clockState.currentBeat = 0;
    this.clockState.isRunning = false;
    this.scheduledDrops = [];
  }

  /**
   * Time to milliseconds
   */
  static barToMs(bars: number, bpm: number): number {
    return (bars * 240000) / bpm; // (bars * 60000 * 4) / bpm
  }

  /**
   * Milliseconds to bars
   */
  static msToBar(ms: number, bpm: number): number {
    return (ms * bpm) / 240000;
  }
}

export const clockBridge = new ClockBridge();
