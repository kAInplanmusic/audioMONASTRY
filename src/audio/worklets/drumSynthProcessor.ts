/**
 * drumSynthProcessor – Synthetische Drums im AudioWorklet
 * --------------------------------------------------------
 * Trigger Kick/Snare/Hat über Port-Nachrichten:
 *   { type:'kick' | 'snare' | 'hat', velocity? }
 * Rendert die segmentierte Drum-Synthese aus `drumSynth.ts` (esbuild-bundled).
 */

import { renderHat, renderKick, renderSnare } from '../../core/instrument/drumSynth';

interface DrumVoice {
  buffer: Float32Array;
  pos: number;
}

const MAX_VOICES = 8;
const FALLBACK_SR = 48000;

class DrumSynthProcessor extends AudioWorkletProcessor {
  private voices: DrumVoice[] = [];
  private sr = FALLBACK_SR;

  constructor() {
    super();
    this.sr = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : FALLBACK_SR;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'kick') this.spawn(renderKick(0.4, this.sr));
      if (m.type === 'snare') this.spawn(renderSnare(0.25, this.sr));
      if (m.type === 'hat') this.spawn(renderHat(0.08, this.sr));
    };
  }

  private spawn(buffer: Float32Array): void {
    if (this.voices.length >= MAX_VOICES) this.voices.shift();
    this.voices.push({ buffer, pos: 0 });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) { // NOSONAR: Worklet
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const blockLen = output[0].length;
    for (let i = 0; i < blockLen; i++) {
      let mix = 0;
      for (const v of this.voices) {
        if (v.pos < v.buffer.length) {
          mix += v.buffer[v.pos];
          v.pos += 1;
        }
      }
      if (!Number.isFinite(mix)) mix = 0;
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = Math.max(-1, Math.min(1, mix));
    }
    this.voices = this.voices.filter((v) => v.pos < v.buffer.length);
    return true;
  }
}

if (typeof registerProcessor !== 'undefined') {
  registerProcessor('drumsynth-processor', DrumSynthProcessor as any);
}
