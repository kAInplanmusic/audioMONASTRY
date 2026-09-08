/**
 * audioMONASTRY · V2SampleClock
 * ==============================
 * Backend-unabhängiger, sample-genauer Step-Scheduler für V2 (Phase 2).
 *
 * Ersetzt die frühere `setInterval`-Schleife des GraphPlaybackEngine-Live-Pfads
 * durch einen Phasen-Akkumulator, der pro Audio-Render-Quantum arbeitet:
 *   - 16tel-Raster exakt in Samples (kein setTimeout-/Main-Thread-Jitter)
 *   - BPM-Wechsel innerhalb eines Quantums (a-rate) wirken sample-genau
 *   - Swing verzögert ungerade Steps um einen sample-gerundeten Offset
 *   - Gate wird als Metadaten transportiert (Note-Länge folgt in Phase 3/4)
 *
 * Die Klasse enthält KEINE WebAudio-/AudioWorklet-API und ist damit sowohl im
 * AudioWorklet (über v2SinkProcessor) als auch in Node-Tests nutzbar.
 */

export interface V2ScheduledStep {
  /** Step-Index innerhalb des Patterns (0..stepCount-1). */
  step: number;
  /** Absoluter Sample-Frame, an dem der Step ausgelöst wird. */
  frame: number;
  /** Audio-Zeit in Sekunden (frame / sampleRate). */
  time: number;
  swing: number;
  gate: number;
  secondsPerStep: number;
}

export interface V2SampleClockOptions {
  sampleRate?: number;
  stepCount?: 16 | 32;
  bpm?: number;
  swing?: number;
  gate?: number;
  /** PDC: Step-Frames um diese Sample-Zahl früher feuern (Mastering-Lookahead). */
  pdcCompensationSamples?: number;
}

export class V2SampleClock {
  readonly sampleRate: number;
  readonly pdcCompensationSamples: number;
  stepCount: 16 | 32;
  bpm: number;
  swing: number;
  gate: number;
  playing = false;

  private stepIndex = 0;
  /** Phasen-Akkumulator (0..1) wie im clockProcessor. */
  private phase = 0;

  constructor(options: V2SampleClockOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.stepCount = options.stepCount ?? 16;
    this.bpm = options.bpm ?? 120;
    this.swing = options.swing ?? 0;
    this.gate = options.gate ?? 0.9;
    this.pdcCompensationSamples = Math.max(0, Math.round(options.pdcCompensationSamples ?? 0));
  }

  /** Setzt Transport zurück: Step 0, Phase 0. */
  reset(): void {
    this.stepIndex = 0;
    this.phase = 0;
  }

  /**
   * Verarbeitet ein Render-Quantum und liefert alle Step-Events, deren
   * Auslösepunkt in [frameStart, frameStart+length) liegt.
   *
   * `bpmParam` kann ein k-rate-Wert (number) oder ein a-rate-Verlauf
   * (Float32Array mit einem Wert pro Sample) sein – wie beim clockProcessor.
   */
  processBlock(frameStart: number, length: number, bpmParam?: number | Float32Array): V2ScheduledStep[] {
    if (!this.playing || length <= 0 || !Number.isFinite(frameStart)) return [];

    const perSample = typeof bpmParam === 'object' && bpmParam.length > 1;
    const bpmArr = perSample ? bpmParam as Float32Array : undefined;
    const result: V2ScheduledStep[] = [];

    for (let i = 0; i < length; i++) {
      const bpm = Math.min(300, Math.max(30, perSample ? bpmArr![i] : (typeof bpmParam === 'number' ? bpmParam : this.bpm)));
      const samplesPerStep = (this.sampleRate * 60.0) / bpm / 4.0; // 16tel in Samples
      this.phase += 1.0 / samplesPerStep;

      if (this.phase >= 1.0) {
        this.phase -= 1.0;
        const globalIndex = this.stepIndex;
        const step = globalIndex % this.stepCount;
        const isOdd = globalIndex % 2 === 1;
        const secondsPerStep = samplesPerStep / this.sampleRate;
        const swingOffset = isOdd ? secondsPerStep * this.swing * 0.5 : 0;
        // Swing wird sample-gerundet, damit das Event im Audio-Thread an einem
        // echten Sample-Frame liegt (kein sub-sample Main-Thread-Offset).
        const rawFrame = frameStart + i + Math.round(swingOffset * this.sampleRate);
        // PDC: Mastering-Lookahead kompensieren (Step feuert früher, hörbares
        // Ereignis landet nach dem Lookahead wieder auf dem Raster).
        const frame = Math.max(0, rawFrame - this.pdcCompensationSamples);

        result.push({
          step,
          frame,
          time: frame / this.sampleRate,
          swing: this.swing,
          gate: this.gate,
          secondsPerStep,
        });
        this.stepIndex = (this.stepIndex + 1) % this.stepCount;
      }
    }

    return result;
  }
}
