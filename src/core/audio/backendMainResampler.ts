/** Stateful stereo windowed-sinc sample-rate conversion. Holds 32 source frames of lookahead. */
export class BackendMainResampler {
  private channels: number[][] = [[], []];
  private base = 0;
  private total = 0;
  private outputIndex = 0;
  private readonly cutoff: number;
  private readonly phaseCount: number;
  private readonly phaseStep: number;
  private readonly phases = new Map<number, { weights: Float64Array; sum: number }>();
  private readonly fallback = { weights: new Float64Array(64), sum: 0 };
  constructor(readonly inputRate: number, readonly outputRate: number) {
    if (!Number.isInteger(inputRate) || !Number.isInteger(outputRate) || inputRate <= 0 || outputRate <= 0) throw new Error('Invalid resampling rate');
    this.cutoff = 0.94 * Math.min(1, outputRate / inputRate);
    // A rational converter repeats after outputRate / gcd(inputRate, outputRate)
    // output frames. Do not allocate an unbounded table for unusual rates.
    let a = inputRate, b = outputRate;
    while (b) { const remainder = a % b; a = b; b = remainder; }
    const count = outputRate / a, step = inputRate / a;
    this.phaseCount = Number.isSafeInteger(count) && Number.isSafeInteger(step) && count <= 1024 && Number.isSafeInteger(count * step) ? count : 0;
    this.phaseStep = step;
  }
  process(input: readonly Float32Array[], frames: number): [Float32Array, Float32Array] {
    if (input.length !== 2 || !Number.isSafeInteger(frames) || frames < 0 || input.some(c => c.length < frames)) throw new Error('Invalid resampler input');
    for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) {
      if (!Number.isFinite(input[c][i])) throw new Error('Non-finite Main audio sample');
      this.channels[c].push(input[c][i]);
    }
    this.total += frames;
    // Count with the same lookahead predicate used by the streaming loop.
    let endIndex = this.outputIndex;
    while (Math.floor(endIndex * this.inputRate / this.outputRate) + 32 < this.total) endIndex++;
    const output: [Float32Array, Float32Array] = [new Float32Array(endIndex - this.outputIndex), new Float32Array(endIndex - this.outputIndex)];
    let out = 0;
    while (this.outputIndex < endIndex) {
      const position = this.outputIndex * this.inputRate / this.outputRate;
      const center = Math.floor(position);
      const phase = this.phaseCount ? this.outputIndex % this.phaseCount : -1;
      let coefficients = this.phases.get(phase);
      if (!coefficients) {
        const fraction = phase < 0 ? position - center : ((phase * this.phaseStep) % this.phaseCount) / this.phaseCount;
        const weights = phase < 0 ? this.fallback.weights : new Float64Array(64);
        let sum = 0;
        for (let offset = -31; offset <= 32; offset++) {
          const distance = fraction - offset;
          const x = Math.PI * this.cutoff * distance;
          const sinc = x === 0 ? 1 : Math.sin(x) / x;
          const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / 32);
          const weight = this.cutoff * sinc * window;
          weights[offset + 31] = weight; sum += weight;
        }
        if (phase < 0) { this.fallback.sum = sum; coefficients = this.fallback; }
        else { coefficients = { weights, sum }; this.phases.set(phase, coefficients); }
      }
      let left = 0, right = 0;
      for (let offset = -31; offset <= 32; offset++) {
        const index = center + offset;
        if (index >= 0) {
          const weight = coefficients.weights[offset + 31];
          left += (this.channels[0][index - this.base] ?? 0) * weight;
          right += (this.channels[1][index - this.base] ?? 0) * weight;
        }
      }
      output[0][out] = left / coefficients.sum; output[1][out] = right / coefficients.sum;
      out++; this.outputIndex++;
    }
    const retainFrom = Math.max(0, Math.floor(this.outputIndex * this.inputRate / this.outputRate) - 31);
    const discard = Math.min(this.total, retainFrom) - this.base;
    if (discard > 0) { this.channels[0].splice(0, discard); this.channels[1].splice(0, discard); this.base += discard; }
    return output;
  }
}
