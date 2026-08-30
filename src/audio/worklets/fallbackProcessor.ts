// src/audio/worklets/fallbackProcessor.ts
class FallbackProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    for (let channel = 0; channel < input.length; ++channel) {
      output[channel].set(input[channel]);
    }
    return true;
  }
}

registerProcessor('fallback-processor', FallbackProcessor);