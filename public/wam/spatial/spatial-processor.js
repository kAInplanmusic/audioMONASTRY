/**
 * Spatial Audio Processor (VBAP)
 * Updated: LFE-Passthrough & DSP-Platzhalter
 */
registerProcessor('spatial-panner-processor', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.positionBuffer = null; // SharedArrayBuffer for position data
    this.x = 0;
    this.y = 0;
    this.port.onmessage = (e) => {
      if (e.data.buffer instanceof SharedArrayBuffer) { // Check if it's the SAB
        this.positionBuffer = new Float32Array(e.data.buffer);
        // Initialize x, y from SAB if already present
        this.x = Atomics.load(this.positionBuffer, 0); 
        this.y = Atomics.load(this.positionBuffer, 1);
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0][0]; // Mono Input
    const output = outputs[0];
    const numChannels = output.length;
    
    // Read x and y from SharedArrayBuffer if available
    if (this.positionBuffer) {
      this.x = Atomics.load(this.positionBuffer, 0); // Read X from index 0
      this.y = Atomics.load(this.positionBuffer, 1); // Read Y from index 1
    }
    
    // --- LFE-Passthrough & DSP-Platzhalter ---
    // In Zukunft: Hier DSP-Modul-Aufrufe für interne Raum-Faltung
    // LFE-Kanal (letzter Kanal) wird im Automode (Amp) belassen
    
    const gains = this.calculateVBAPGains(this.x, this.y, numChannels);
    
    for (let channel = 0; channel < numChannels; channel++) {
      // Wenn es der LFE-Kanal ist (Index 8 für 8.1 oder 10 für 10.1), umgehe das Panning
      if (channel === numChannels - 1) {
          output[channel].set(input); // Raw passthrough to LFE
      } else {
          // Normales VBAP Panning
          const outputChannel = output[channel];
          for (let i = 0; i < input.length; i++) {
            outputChannel[i] = input[i] * gains[channel];
          }
      }
    }
    return true;
  }

  calculateVBAPGains(x, y, numChannels) {
    const gains = new Array(numChannels).fill(0);
    // ... Platzhalter für komplexe Matrix ...
    return gains;
  }
});
