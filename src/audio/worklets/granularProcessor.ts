/**
 * granularProcessor – Echtzeit-Granular-Engine (AudioWorklet)
 * ------------------------------------------------------------
 * Produktionspfad der Granular-Engine: spielt Körner aus einem per
 * `postMessage({ buffer })` übergebenen SharedArrayBuffer/Float32Array-Source.
 * Parameter (Port-Nachrichten): grainSize, density, position, positionJitter,
 * pitch, pitchJitter, direction, freeze, gain.
 *
 * Hot-Path ohne Allokationen: fester Grain-Slot-Pool (64 Slots) + vorberechnete
 * Hann-Fenster-Tabelle. NaN/Inf-sicher, deterministischer Seed (freeze = feste
 * Position).
 */

const TAU = 2 * Math.PI;
const MAX_GRAINS = 64;
const WINDOW_LUT_SIZE = 8192;

interface GrainSlot {
  active: boolean;
  start: number;
  srcPos: number;
  len: number;
  pos: number;
  pitch: number;
  dir: number;
}

class GranularProcessor extends AudioWorkletProcessor {
  private src: Float32Array | null = null;
  private srcLen = 0;
  private grainSize = 480;
  private density = 20;
  private position = 0;
  private positionJitter = 0;
  private pitch = 1;
  private pitchJitter = 0;
  private direction = 1;
  private freeze = false;
  private gain = 0.8;

  private nextGrainFrame = 0;
  private rndState = 12345;
  private slots: GrainSlot[] = Array.from({ length: MAX_GRAINS }, () => ({
    active: false, start: 0, srcPos: 0, len: 0, pos: 0, pitch: 1, dir: 1,
  }));
  private windowLut = new Float32Array(WINDOW_LUT_SIZE);

  constructor() {
    super();
    for (let i = 0; i < WINDOW_LUT_SIZE; i++) {
      this.windowLut[i] = 0.5 * (1 - Math.cos((TAU * i) / (WINDOW_LUT_SIZE - 1)));
    }
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.buffer instanceof Float32Array) { this.src = m.buffer; this.srcLen = m.buffer.length; this.nextGrainFrame = 0; }
      if (typeof m.grainSize === 'number') this.grainSize = Math.max(32, Math.min(8192, Math.round(m.grainSize)));
      if (typeof m.density === 'number') this.density = Math.max(1, Math.min(500, m.density));
      if (typeof m.position === 'number') this.position = Math.max(0, Math.min(1, m.position));
      if (typeof m.positionJitter === 'number') this.positionJitter = Math.max(0, Math.min(1, m.positionJitter));
      if (typeof m.pitch === 'number') this.pitch = Math.max(0.25, Math.min(4, m.pitch));
      if (typeof m.pitchJitter === 'number') this.pitchJitter = Math.max(0, Math.min(1, m.pitchJitter));
      if (typeof m.direction === 'number') this.direction = m.direction >= 0 ? 1 : -1;
      if (typeof m.freeze === 'boolean') this.freeze = m.freeze;
      if (typeof m.gain === 'number') this.gain = Math.max(0, Math.min(1.5, m.gain));
    };
  }

  private rand(): number {
    this.rndState = (this.rndState * 1664525 + 1013904223) >>> 0;
    return this.rndState / 2 ** 32;
  }

  private spawn(frame: number): void {
    if (!this.src || this.srcLen === 0) return;
    const len = Math.min(this.grainSize, this.srcLen);
    const basePos = Math.max(0, Math.min(1, this.position)) * Math.max(0, this.srcLen - len);
    const jitter = this.freeze ? 0 : (this.rand() * 2 - 1) * this.positionJitter * len;
    const srcPos = Math.max(0, Math.min(this.srcLen - len, Math.floor(basePos + jitter)));
    const pitch = Math.max(0.25, Math.min(4, this.pitch * (1 + (this.rand() * 2 - 1) * this.pitchJitter)));
    for (const s of this.slots) {
      if (!s.active) {
        s.active = true;
        s.start = frame;
        s.srcPos = srcPos;
        s.len = len;
        s.pos = 0;
        s.pitch = pitch;
        s.dir = this.direction;
        return;
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) { // NOSONAR: Worklet
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const blockLen = output[0].length;
    const stepFrames = Math.max(this.grainSize / 2, Math.round(sampleRate / this.density));

    for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);

    for (let i = 0; i < blockLen; i++) {
      const frame = currentFrame + i;
      while (frame >= this.nextGrainFrame) {
        this.spawn(this.nextGrainFrame);
        this.nextGrainFrame += stepFrames;
      }

      let sample = 0;
      for (const s of this.slots) {
        if (!s.active) continue;
        const local = frame - s.start;
        if (local >= s.len) { s.active = false; continue; }
        const srcIdx = s.dir === 1 ? s.srcPos + Math.floor(local * s.pitch) : s.srcPos + s.len - 1 - Math.floor(local * s.pitch);
        if (srcIdx < 0 || srcIdx >= this.srcLen) continue;
        const winIdx = Math.min(WINDOW_LUT_SIZE - 1, Math.floor((local / Math.max(1, s.len - 1)) * (WINDOW_LUT_SIZE - 1)));
        sample += (this.src?.[srcIdx] ?? 0) * this.windowLut[winIdx];
      }
      sample *= this.gain;
      if (!Number.isFinite(sample)) sample = 0;
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = sample;
    }
    return true;
  }
}

if (typeof registerProcessor !== 'undefined') {
  registerProcessor('granular-processor', GranularProcessor as any);
}
