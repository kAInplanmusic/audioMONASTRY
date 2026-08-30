// src/audio/worklets/analyzerProcessor.ts
class AnalyzerProcessor extends AudioWorkletProcessor {
  private sharedBuffer: Float32Array | null = null;
  private lastBlockTime = -1;
  private dropouts = 0;
  private dropoutsReported = 0;

  constructor() {
    super();
    this.port.onmessage = (e) => {
      if (e.data.buffer) {
        this.sharedBuffer = new Float32Array(e.data.buffer);
      }
    };
  }

  process(inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>) {
    const input = inputs[0];

    // Underrun-/Dropout-Erkennung: Lücke zwischen Audio-Blöcken messen.
    // Normalabstand = 128 Samples / sampleRate. > 1.5 Quanten = Dropout.
    const now = currentTime;
    if (this.lastBlockTime >= 0) {
      const gap = now - this.lastBlockTime;
      const quantum = 128 / sampleRate;
      if (gap > quantum * 1.5) this.dropouts += 1;
    }
    this.lastBlockTime = now;
    if (this.dropouts > this.dropoutsReported) {
      this.dropoutsReported = this.dropouts;
      this.port.postMessage({ type: 'dropout', count: this.dropouts });
    }

    // Roh-Audiodaten in den Shared Buffer schreiben (ohne `slice`-Allokation).
    if (this.sharedBuffer && input.length > 0) {
      const src = input[0];
      const dst = this.sharedBuffer;
      const n = Math.min(src.length, dst.length);
      for (let i = 0; i < n; i++) dst[i] = src[i];
    }

    return true;
  }
}
registerProcessor('analyzer-processor', AnalyzerProcessor);
