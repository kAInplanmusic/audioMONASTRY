/**
 * fm6Processor – 6-Operator-FM-Worklet (DX7-Architektur)
 * ------------------------------------------------------
 * Produktions-Live-Pfad der 6-Op-FM-Engine. Nutzt `Fm6Synth` aus
 * `src/core/instrument/fmEngine.ts` (esbuild bundle inlined beim Worklet-Build).
 *
 * Port-Nachrichten:
 *   { type:'patch', patch: Dx7Patch }     – Patch setzen
 *   { type:'noteOn', noteHz, velocity }   – Stimme starten
 *   { type:'noteOff', noteHz }            – Stimme releasen
 *   { type:'gain', value }                – Master-Gain
 */
import { Fm6Synth, type Dx7Patch } from '../../core/instrument/fmEngine';

const FALLBACK_SR = 48000;

class Fm6Processor extends AudioWorkletProcessor {
  private synth: Fm6Synth | null = null;
  private patch: Dx7Patch | null = null;

  constructor() {
    super();
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'patch' && m.patch) {
        this.patch = m.patch as Dx7Patch;
        const sr = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : FALLBACK_SR;
        this.synth = new Fm6Synth(this.patch, sr, 16);
      }
      if (m.type === 'noteOn' && typeof m.noteHz === 'number' && this.synth) {
        this.synth.noteOn(m.noteHz, typeof m.velocity === 'number' ? m.velocity : 0.8);
      }
      if (m.type === 'noteOff' && typeof m.noteHz === 'number' && this.synth) {
        this.synth.noteOff(m.noteHz);
      }
      if (m.type === 'gain' && typeof m.value === 'number' && this.synth) {
        this.synth.masterGain = Math.max(0, Math.min(1.5, m.value));
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) { // NOSONAR: Worklet
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const blockLen = output[0].length;
    if (this.synth) {
      const mix = new Float32Array(blockLen);
      this.synth.renderBlock(mix, blockLen);
      for (let ch = 0; ch < output.length; ch++) output[ch].set(mix);
    } else {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
    }
    return true;
  }
}

if (typeof registerProcessor !== 'undefined') {
  registerProcessor('fm6-processor', Fm6Processor as any);
}
