// src/audio/worklets/lufsProcessor.ts
class LufsProcessor extends AudioWorkletProcessor {
  private lufsBuffer: Int32Array | null = null; // SAB for LUFS data (scaled to int)

  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data.buffer) {
        this.lufsBuffer = new Int32Array(event.data.buffer);
      }
    };
  }

  process(inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>) {
    const input = inputs[0];
    if (input.length > 0 && this.lufsBuffer) { // Check if SAB is available
      let sum = 0;
      for (let i = 0; i < input[0].length; i++) {
        sum += input[0][i] * input[0][i];
      }
      const rms = Math.sqrt(sum / input[0].length);
      const lufs = 20 * Math.log10(rms) - 0.691;
      
      // Store scaled value (multiply by 100 to preserve 2 decimal places)
      Atomics.store(this.lufsBuffer, 0, Math.round(lufs * 100));
    }
    return true;
  }
}
registerProcessor('lufs-processor', LufsProcessor);
