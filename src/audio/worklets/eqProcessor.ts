/**
 * eqProcessor – 12-Band parametrischer Equalizer (AudioWorklet)
 * ------------------------------------------------------------
 * 12 unabhängige Biquad-Bänder in Serie. Unterstützte Typen:
 * peaking · lowshelf · highshelf · highpass · lowpass
 *
 * Steuerung über Port-Nachrichten:
 *   { bands: [{ freq, gain, q, type }], reset? }   ← 12-Band-Protokoll
 *   { band: 'low'|'mid'|'high'|'hp', gain, freq, q } ← Legacy (4-Band)
 *
 * Basiert auf Biquad-Filterkoeffizienten (RBJ Audio EQ Cookbook).
 */

type FilterType = 'peaking' | 'lowshelf' | 'highshelf' | 'highpass' | 'lowpass';

interface BandState {
  type: FilterType;
  co: number[]; // [b0, b1, b2, a1, a2]
  z: [number, number];
}

const NUM_BANDS = 36;

/** Standard-Frequenzen (1/3-Oktav-Raster 20 Hz–20 kHz), falls eine Band-Message ohne freq kommt. */
const DEFAULT_FREQS = Array.from({ length: NUM_BANDS }, (_, i) =>
  Math.round(20 * Math.pow(10, (i * 3) / 35)),
);

class EqProcessor extends AudioWorkletProcessor {
  private bands: BandState[] = [];
  // Block-genaue Gain-Rampen (automate): aktueller Gain + Ziel je Band.
  private bandGain = new Float32Array(NUM_BANDS);
  private bandFreq = new Float32Array(NUM_BANDS);
  private bandQ = new Float32Array(NUM_BANDS);
  private rampTargets = new Float32Array(NUM_BANDS);
  private rampSteps = new Int32Array(NUM_BANDS);
  private rampDeltas = new Float32Array(NUM_BANDS);

  constructor() {
    super();
    for (let i = 0; i < NUM_BANDS; i++) {
      this.bands.push({ type: 'peaking', co: [1, 0, 0, 0, 0], z: [0, 0] });
      this.bandFreq[i] = DEFAULT_FREQS[i];
      this.bandQ[i] = 1;
    }
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  private onMessage(m: any) {
    if (!m) return;
    if (m.reset) {
      this.bands.forEach((b) => { b.z = [0, 0]; });
    }
    if (m.type === 'automate' && m.param === 'bandGain' && typeof m.value === 'number') {
      // Band-Gain linear über rampTime (block-genau) rampen – zipper-frei.
      const idx = Math.max(0, Math.min(NUM_BANDS - 1, Number(m.band ?? 0) | 0));
      const steps = Math.max(1, Math.round(Number(m.rampTime ?? 0.02) * sampleRate / 128));
      this.rampTargets[idx] = Math.max(-24, Math.min(24, m.value));
      this.rampSteps[idx] = steps;
      this.rampDeltas[idx] = (this.rampTargets[idx] - this.bandGain[idx]) / steps;
      return;
    }
    if (Array.isArray(m.bands)) {
      // Volles 12-Band-Protokoll: fehlende Bänder werden flach (0 dB) gesetzt.
      for (let i = 0; i < NUM_BANDS; i++) {
        const b = m.bands[i] ?? {};
        const type = (b.type as FilterType) ?? (i === 0 ? 'lowshelf' : i === NUM_BANDS - 1 ? 'highshelf' : 'peaking');
        const gain = Number(b.gain ?? 0);
        const freq = Number(b.freq ?? DEFAULT_FREQS[i]);
        const q = Number(b.q ?? 1);
        this.configure(i, type, gain, freq, q);
      }
    } else if (m.band !== undefined) {
      // Legacy 4-Band-Protokoll (Abwärtskompatibilität zu setEqBand).
      const legacy: Record<string, { idx: number; type: FilterType }> = {
        hp: { idx: 0, type: 'highpass' },
        low: { idx: 1, type: 'lowshelf' },
        mid: { idx: 2, type: 'peaking' },
        high: { idx: 3, type: 'highshelf' },
      };
      const slot = legacy[m.band];
      if (slot) {
        this.configure(slot.idx, slot.type, Number(m.gain ?? 0), Number(m.freq ?? 1000), Number(m.q ?? 1));
      }
    }
  }

  private configure(i: number, type: FilterType, gain: number, freq: number, q: number) {
    const b = this.bands[i];
    if (!b) return;
    b.type = type;
    const g = Math.max(-24, Math.min(24, gain));
    const f = Math.max(10, Math.min(22000, freq));
    const qq = Math.max(0.1, Math.min(12, q));
    this.bandGain[i] = g;
    this.bandFreq[i] = f;
    this.bandQ[i] = qq;
    switch (type) {
      case 'highpass': this.setHighpass(b, f, qq); break;
      case 'lowpass': this.setLowpass(b, f, qq); break;
      case 'lowshelf': this.setLowshelf(b, g, f, qq); break;
      case 'highshelf': this.setHighshelf(b, g, f, qq); break;
      default: this.setPeaking(b, g, f, qq);
    }
  }

  // --- Biquad-Setups (RBJ Cookbook) ---
  private setHighpass(f: BandState, freq: number, q: number) {
    const w = 2 * Math.PI * freq / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const b0 = (1 + cw) / 2, b1 = -(1 + cw), b2 = b0;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    f.co = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  private setLowpass(f: BandState, freq: number, q: number) {
    const w = 2 * Math.PI * freq / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    f.co = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  private setLowshelf(f: BandState, gain: number, freq: number, q: number) {
    const w = 2 * Math.PI * freq / sampleRate; const a = Math.pow(10, gain / 40);
    const cw = Math.cos(w), sn = Math.sin(w);
    const alpha = sn / 2 * Math.sqrt((a + 1 / a) * (1 / q - 1) + 2);
    const twoSA = 2 * Math.sqrt(a) * alpha;
    const b0 = a * ((a + 1) - (a - 1) * cw + twoSA);
    const b1 = 2 * a * ((a - 1) - (a + 1) * cw);
    const b2 = a * ((a + 1) - (a - 1) * cw - twoSA);
    const a0 = (a + 1) + (a - 1) * cw + twoSA;
    const a1 = -2 * ((a - 1) + (a + 1) * cw);
    const a2 = (a + 1) + (a - 1) * cw - twoSA;
    f.co = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  private setHighshelf(f: BandState, gain: number, freq: number, q: number) {
    const w = 2 * Math.PI * freq / sampleRate; const a = Math.pow(10, gain / 40);
    const cw = Math.cos(w), sn = Math.sin(w);
    const alpha = sn / 2 * Math.sqrt((a + 1 / a) * (1 / q - 1) + 2);
    const twoSA = 2 * Math.sqrt(a) * alpha;
    const b0 = a * ((a + 1) + (a - 1) * cw + twoSA);
    const b1 = -2 * a * ((a - 1) + (a + 1) * cw);
    const b2 = a * ((a + 1) + (a - 1) * cw - twoSA);
    const a0 = (a + 1) - (a - 1) * cw + twoSA;
    const a1 = 2 * ((a - 1) - (a + 1) * cw);
    const a2 = (a + 1) - (a - 1) * cw - twoSA;
    f.co = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  private setPeaking(f: BandState, gain: number, freq: number, q: number) {
    const w = 2 * Math.PI * freq / sampleRate; const a = Math.pow(10, gain / 40);
    const cw = Math.cos(w), sn = Math.sin(w);
    const alpha = sn / (2 * q);
    const b0 = 1 + alpha * a, b1 = -2 * cw, b2 = 1 - alpha * a;
    const a0 = 1 + alpha / a, a1 = -2 * cw, a2 = 1 - alpha / a;
    f.co = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  // Biquad übertragen (DF2T)
  private biquad(f: BandState, x: number): number {
    const [b0, b1, b2, a1, a2] = f.co;
    const y = b0 * x + f.z[0];
    f.z[0] = b1 * x - a1 * y + f.z[1];
    f.z[1] = b2 * x - a2 * y;
    return y;
  }

  /** Block-genau: laufende Band-Gain-Rampen einen Schritt bewegen + neu konfigurieren. */
  private stepRamps(): void {
    for (let i = 0; i < NUM_BANDS; i++) {
      if (this.rampSteps[i] <= 0) continue;
      this.rampSteps[i] -= 1;
      if (this.rampSteps[i] <= 0) this.bandGain[i] = this.rampTargets[i];
      else this.bandGain[i] += this.rampDeltas[i];
      // Koeffizienten mit geramptem Gain neu berechnen (nur aktive Bänder).
      const b = this.bands[i];
      switch (b.type) {
        case 'highpass': this.setHighpass(b, this.bandFreq[i], this.bandQ[i]); break;
        case 'lowpass': this.setLowpass(b, this.bandFreq[i], this.bandQ[i]); break;
        case 'lowshelf': this.setLowshelf(b, this.bandGain[i], this.bandFreq[i], this.bandQ[i]); break;
        case 'highshelf': this.setHighshelf(b, this.bandGain[i], this.bandFreq[i], this.bandQ[i]); break;
        default: this.setPeaking(b, this.bandGain[i], this.bandFreq[i], this.bandQ[i]);
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) { // NOSONAR: AudioWorkletProcessor muss true liefern
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;
    this.stepRamps(); // block-genaue Band-Gain-Rampen (automate)
    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch] || input[0];
      const outCh = output[ch];
      for (let i = 0; i < outCh.length; i++) {
        let s = inCh[i] ?? 0;
        for (let b = 0; b < NUM_BANDS; b++) s = this.biquad(this.bands[b], s);
        outCh[i] = Number.isFinite(s) ? s : 0;
      }
    }
    return true;
  }
}

registerProcessor('eq-processor', EqProcessor);
