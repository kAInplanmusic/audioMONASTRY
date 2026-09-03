/**
 * dropMONK – Clock Synchronization Bridge
 * ======================================
 * Synchronize drops with master clock for quantized recall
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
    targetBar: number;
    callback: () => void;
  }> = [];

  /**
   * Initialize clock bridge
   * TODO: Connect to masterClock from audioEngine
   */
  initialize(bpm: number, sampleRate: number): void {
    this.clockState.bpm = bpm;
    this.clockState.sampleRate = sampleRate;
  }

  /**
   * Update clock state
   * Called frequently (e.g., from audio worklet)
   */
  updateClock(currentSample: number, isRunning: boolean): void {
    this.clockState.isRunning = isRunning;
    this.clockState.currentSample = currentSample;

    const samplesPerBeat = this.clockState.sampleRate / (this.clockState.bpm / 60);
    const currentBeat = Math.floor(currentSample / samplesPerBeat);
    const currentBar = Math.floor(currentBeat / 4); // 4/4 time

    this.clockState.currentBeat = currentBeat % 4;
    this.clockState.currentBar = currentBar;

    // Check scheduled drops
    this._processScheduledDrops();
  }

  /**
   * Get current clock state
   */
  getClockState(): ClockState {
    return { ...this.clockState };
  }

  /**
   * Get samples to next beat
   */
  getSamplesToNextBeat(): number {
    const samplesPerBeat = this.clockState.sampleRate / (this.clockState.bpm / 60);
    const samplesInCurrentBeat = this.clockState.currentSample % samplesPerBeat;
    return Math.ceil(samplesPerBeat - samplesInCurrentBeat);
  }

  /**
   * Get samples to next bar
   */
  getSamplesToNextBar(): number {
    const samplesPerBeat = this.clockState.sampleRate / (this.clockState.bpm / 60);
    const samplesPerBar = samplesPerBeat * 4;
    const samplesInCurrentBar = this.clockState.currentSample % samplesPerBar;
    return Math.ceil(samplesPerBar - samplesInCurrentBar);
  }

  /**
   * Calculate delay until quantization point
   */
  getDelayToQuantization(quantization: QuantizationLevel): number {
    const samplesPerBeat = this.clockState.sampleRate / (this.clockState.bpm / 60);

    const quantizationMap: Record<QuantizationLevel, number> = {
      '1beat': samplesPerBeat,
      '2beat': samplesPerBeat * 2,
      '1bar': samplesPerBeat * 4,
      '2bar': samplesPerBeat * 8,
      '4bar': samplesPerBeat * 16,
      '8bar': samplesPerBeat * 32,
    };

    const samplesPerQuantum = quantizationMap[quantization];
    const samplesInCurrent = this.clockState.currentSample % samplesPerQuantum;
    return Math.ceil(samplesPerQuantum - samplesInCurrent);
  }

  /**
   * Schedule a drop on next quantization point
   */
  scheduleDrop(callback: () => void, quantization: QuantizationLevel = '4bar'): string {
    const samplesPerBeat = this.clockState.sampleRate / (this.clockState.bpm / 60);

    const quantizationMap: Record<QuantizationLevel, number> = {
      '1beat': samplesPerBeat,
      '2beat': samplesPerBeat * 2,
      '1bar': samplesPerBeat * 4,
      '2bar': samplesPerBeat * 8,
      '4bar': samplesPerBeat * 16,
      '8bar': samplesPerBeat * 32,
    };

    const samplesPerQuantum = quantizationMap[quantization];
    const samplesInCurrent = this.clockState.currentSample % samplesPerQuantum;
    const samplesUntilQuantum = Math.ceil(samplesPerQuantum - samplesInCurrent);
    const targetSample = this.clockState.currentSample + samplesUntilQuantum;
    const targetBar = Math.floor(targetSample / (samplesPerBeat * 4));

    const id = `drop_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    this.scheduledDrops.push({ id, targetBar, callback });

    return id;
  }

  /**
   * Cancel scheduled drop
   */
  cancelScheduledDrop(id: string): void {
    this.scheduledDrops = this.scheduledDrops.filter((d) => d.id !== id);
  }

  /**
   * Process scheduled drops
   */
  private _processScheduledDrops(): void {
    this.scheduledDrops = this.scheduledDrops.filter((drop) => {
      if (this.clockState.currentBar >= drop.targetBar) {
        drop.callback();
        return false; // Remove from queue
      }
      return true;
    });
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
    for (const callback of this.callbacks.values()) {
      callback(this.clockState);
    }
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
