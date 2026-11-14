/** Stateful stereo windowed-sinc sample-rate conversion. Holds 32 source frames of lookahead. */
export class BackendMainResampler {
  private channels: number[][] = [[], []];
  private base = 0;
  private total = 0;
  private outputIndex = 0;
  private readonly cutoff: number;
  constructor(readonly inputRate: number, readonly outputRate: number) {
    if (!Number.isInteger(inputRate) || !Number.isInteger(outputRate) || inputRate <= 0 || outputRate <= 0) throw new Error('Invalid resampling rate');
    this.cutoff = 0.94 * Math.min(1, outputRate / inputRate);
  }
  process(input: readonly Float32Array[], frames: number): [Float32Array, Float32Array] {
    if (input.length !== 2 || !Number.isSafeInteger(frames) || frames < 0 || input.some(c => c.length < frames)) throw new Error('Invalid resampler input');
    for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) {
      if (!Number.isFinite(input[c][i])) throw new Error('Non-finite Main audio sample');
      this.channels[c].push(input[c][i]);
    }
    this.total += frames;
    const output: number[][] = [[], []];
    while (Math.floor(this.outputIndex * this.inputRate / this.outputRate) + 32 < this.total) {
      const position = this.outputIndex * this.inputRate / this.outputRate;
      const center = Math.floor(position);
      let weightSum = 0, left = 0, right = 0;
      for (let offset = -31; offset <= 32; offset++) {
        const index = center + offset, distance = position - index;
        const x = Math.PI * this.cutoff * distance;
        const sinc = x === 0 ? 1 : Math.sin(x) / x;
        const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / 32);
        const weight = this.cutoff * sinc * window;
        weightSum += weight;
        if (index >= 0) { left += (this.channels[0][index - this.base] ?? 0) * weight; right += (this.channels[1][index - this.base] ?? 0) * weight; }
      }
      output[0].push(left / weightSum); output[1].push(right / weightSum); this.outputIndex++;
    }
    const retainFrom = Math.max(0, Math.floor(this.outputIndex * this.inputRate / this.outputRate) - 31);
    const discard = Math.min(this.total, retainFrom) - this.base;
    if (discard > 0) { this.channels[0].splice(0, discard); this.channels[1].splice(0, discard); this.base += discard; }
    return [Float32Array.from(output[0]), Float32Array.from(output[1])];
  }
}
