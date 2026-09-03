// src/audio/worklets/fallbackProcessor.ts
//
// P0-4: Platzhalter für fehlende/nicht ladbare Worklets. Der Prozessor reicht
// das Eingangssignal 1:1 durch, sanitisiert dabei aber jeden Sample-Wert:
// NaN/Inf werden zu 0, fehlende Eingangskanäle liefern Stille. So kann ein
// Fallback niemals Rauschen oder Denormal-Müll auf den Main-Bus schicken.
class FallbackProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    for (let channel = 0; channel < output.length; ++channel) {
      const outChannel = output[channel];
      const inChannel = input[channel];
      if (!inChannel) {
        outChannel.fill(0);
        continue;
      }
      for (let i = 0; i < outChannel.length; ++i) {
        const sample = inChannel[i];
        outChannel[i] = Number.isFinite(sample) ? sample : 0;
      }
    }
    return true;
  }
}

registerProcessor('fallback-processor', FallbackProcessor);
