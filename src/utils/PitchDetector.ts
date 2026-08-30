// src/utils/PitchDetector.ts
export class PitchDetector {
  private analyser: AnalyserNode;
  private buffer: Float32Array;
  private sampleRate: number;

  constructor(audioContext: AudioContext) {
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.sampleRate = audioContext.sampleRate;
  }

  public getNote(): number | null {
    this.analyser.getFloatTimeDomainData(this.buffer);
    
    // Simple Autocorrelation algorithm
    let bestOffset = -1;
    let bestCorrelation = 0;
    const rms = Math.sqrt(this.buffer.reduce((acc, val) => acc + val * val, 0) / this.buffer.length);

    // If signal is too quiet, return null
    if (rms < 0.01) return null;

    for (let offset = 20; offset < 1000; offset++) {
      let correlation = 0;
      for (let i = 0; i < this.buffer.length - offset; i++) {
        correlation += this.buffer[i] * this.buffer[i + offset];
      }
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestOffset = offset;
      }
    }

    if (bestOffset === -1) return null;

    const frequency = this.sampleRate / bestOffset;
    
    // Convert frequency to MIDI note
    const note = 12 * (Math.log2(frequency / 440)) + 69;
    return Math.round(note);
  }
}
