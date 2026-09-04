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
 * P2-2: BPM-Wechsel sind sample-genau. Der `bpm`-AudioParam läuft mit
 * `automationRate: 'a-rate'` (ein Wert pro Sample) und treibt einen
 * Phasen-Akkumulator – ein per `setValueAtTime` gesetztes Tempo wirkt damit
 * exakt am Ziel-Sample (kein Main-Thread-/setTimeout-Jitter). Die
 * Port-Nachricht `{ bpm }` bleibt als Fallback erhalten (Worklet ohne
 * Automation-API bzw. Test-Harness).
 *
 * Swing: ungerade Steps um `swingOffset` verzögern (Anteil an 16tel-Dauer).
 * Gate: `gateLength` als Anteil der Step-Dauer (0.0–1.0).
 */

class ClockProcessor extends AudioWorkletProcessor {
  private step = 0;
  private bpm = 120;
  private swing = 0.0; // 0..1
  private gate = 0.9;  // 0..1
  /** P2-2: Phasen-Akkumulator (0..1) für sample-genaues Step-Scheduling. */
  private phase = 0;

  static get parameterDescriptors() {
    return [
      // a-rate: ein Wert pro Sample → sample-genaue BPM-Wechsel.
      { name: 'bpm', defaultValue: 120, minValue: 30, maxValue: 300, automationRate: 'a-rate' },
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
      if (msg.reset) { this.step = 0; this.phase = 0; }
    };
  }

  process(_inputs: Float32Array[][], _outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const currentTime = currentFrame / sampleRate;
    const bpmParam = parameters?.bpm;
    const bpmArr = bpmParam as Float32Array | undefined;
    // a-rate liefert einen Wert pro Sample (Standard-Quantum 128), k-rate/Test
    // einen einzelnen Wert. Wir unterstützen beides.
    const perSample = !!bpmArr && bpmArr.length > 1;
    const blockLen = perSample ? bpmArr!.length : 128;
    const swingNow = Math.min(1, Math.max(0, parameters?.swing?.[0] ?? this.swing));
    const gateNow = Math.min(1, Math.max(0.01, parameters?.gate?.[0] ?? this.gate));

    for (let i = 0; i < blockLen; i++) {
      const bpmNow = Math.min(300, Math.max(30, perSample ? bpmArr![i] : (bpmArr?.[0] ?? this.bpm)));
      const samplesPerStep = (sampleRate * 60.0) / bpmNow / 4.0; // 16tel in Samples
      this.phase += 1.0 / samplesPerStep;

      if (this.phase >= 1.0) {
        this.phase -= 1.0;
        const stepIndexInBar = this.step % 16;
        const isOdd = stepIndexInBar % 2 === 1; // ungerade 16tel
        const secondsPerStep = samplesPerStep / sampleRate;
        const swingOffset = isOdd ? secondsPerStep * swingNow * 0.5 : 0;

        this.port.postMessage({
          type: 'step',
          step: this.step % 16,
          time: currentTime + i / sampleRate + swingOffset, // exakte Audio-Clock-Zeit
          swing: swingNow,
          gate: gateNow,
          secondsPerStep,
        });
        this.step = (this.step + 1) % 64; // 64 Steps (16/bar * 4 bars) zyklen
      }
    }

    return true;
  }
}

registerProcessor('clock-processor', ClockProcessor);
