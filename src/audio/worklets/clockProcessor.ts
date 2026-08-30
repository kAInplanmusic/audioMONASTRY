/**
 * clockProcessor – AudioWorklet-Clock-Generator
 * ---------------------------------------------
 * Statt `setInterval`/`setTimeout` auf dem Main-Thread (jitter-anfällig) liefert
 * dieser Processor präzise Step-Impulse direkt aus der Audio-Rendering-Schleife.
 *
 * Er sendet pro 16tel-Step einen MessagePort-Callback an den Main-Thread. Der
 * Main-Thread plant die eigentlichen Noten über `Tone.now()`/`currentTime`
 * (Lookahead bleibt im Main-Thread; dieser Worklet liefert nur den präzisen Takt).
 *
 * Swing: ungerade Steps um `swingOffset` verzögern (Anteil an 16tel-Dauer).
 * Gate: `gateLength` als Anteil der Step-Dauer (0.0–1.0).
 */

class ClockProcessor extends AudioWorkletProcessor {
  private step = 0;
  private bpm = 120;
  private swing = 0.0; // 0..1
  private gate = 0.9;  // 0..1
  private previousTickTime = 0;

  static get parameterDescriptors() {
    return [
      { name: 'bpm', defaultValue: 120, minValue: 30, maxValue: 300, automationRate: 'k-rate' },
      { name: 'swing', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gate', defaultValue: 0.9, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      if (typeof msg.bpm === 'number') this.bpm = Math.min(300, Math.max(30, msg.bpm));
      if (typeof msg.swing === 'number') this.swing = Math.min(1, Math.max(0, msg.swing));
      if (typeof msg.gate === 'number') this.gate = Math.min(1, Math.max(0.01, msg.gate));
      if (msg.reset) this.step = 0;
    };
  }

  process(_inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    const currentTime = currentFrame / sampleRate;
    const bpm = Math.min(300, Math.max(30, this.bpm));
    const secondsPerStep = (60.0 / bpm) / 4.0; // 16tel

    // Berechne Swing-Offset für ungerade Steps
    const stepIndexInBar = this.step % 16; // 0..15
    const isOdd = stepIndexInBar % 2 === 1; // ungerade 16tel
    const swingOffset = isOdd ? secondsPerStep * this.swing * 0.5 : 0;

    const triggerTime = currentTime + swingOffset;

    // Sende Step-Impuls einmal pro Step (wenn genug Zeit vergangen)
    if (triggerTime - this.previousTickTime >= secondsPerStep - 0.0001) {
      this.port.postMessage({
        type: 'step',
        step: this.step % 16,
        time: currentTime,          // exakte Audio-Clock-Zeit
        swing: this.swing,
        gate: this.gate,
        secondsPerStep,
      });
      this.previousTickTime = triggerTime;
      this.step = (this.step + 1) % 64; // 64 = 64 Steps (16/bar * 4 bars) zyklen
    }

    return true;
  }
}

registerProcessor('clock-processor', ClockProcessor);
