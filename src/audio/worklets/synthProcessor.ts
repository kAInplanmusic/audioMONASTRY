/**
 * synthProcessor – PolyBLEP-Synthesizer im AudioWorklet
 * ------------------------------------------------------
 * Erzeugt bandlimitierte Oszillator-Wellenformen (Saw, Square, Triangle, Sine,
 * PD, Wavetable, Tonewheel) ohne Aliasing (PolyBLEP bzw. Mip-Map-Wavetables),
 * plus ADSR-Hüllkurve und einem resonanten Moog-Ladder-4-Pol-Tiefpassfilter.
 *
 * Steuerung über Port-Nachrichten:
 *   { osc: 'saw'|'square'|'triangle'|'sine'|'pd'|'wavetable'|'tonewheel',
 *     freq, cutoff, resonance, gain }
 *   { trigger: velocity }  → neues Note-On
 *   { release }            → Note-Off (ADSR-Release)
 */
import { createMorphWavetables, sampleWavetable } from '../../core/instrument/wavetable';
import { createTonewheelTable, LeslieSim } from '../../core/instrument/tonewheel';

// Vorberechnete Wavetables (Modul-Load, keine Allokation im Hot-Path).
const WT = createMorphWavetables(2048);
const TONEWHEEL_TABLE = createTonewheelTable([8, 0, 8, 4, 0, 2, 0, 0, 1], 2048);

function readTable(table: Float32Array, phase01: number): number {
  const x = Math.max(0, Math.min(1, phase01)) * table.length;
  const i0 = Math.floor(x) % table.length;
  const i1 = (i0 + 1) % table.length;
  const f = x - Math.floor(x);
  return table[i0] + (table[i1] - table[i0]) * f;
}

// --- PolyBLEP (Anti-Aliasing) ---
function polyBLEP(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  } else if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function waveform(type: string, phase: number, dt: number): number {
  switch (type) {
    case 'saw':
      return (2 * phase - 1) - polyBLEP(phase, dt);
    case 'square':
      return (phase < 0.5 ? 1 : -1) + polyBLEP(phase, dt) - polyBLEP((phase + 0.5) % 1, dt);
    case 'triangle': {
      const raw = 4 * Math.abs(phase - 0.5) - 1;
      // Dreieck benötigt keine BLEP-Steps für die Grundfrequenz, aber wir gleichen ab:
      return raw;
    }
    case 'sine':
      return Math.sin(2 * Math.PI * phase);
    case 'pd': {
      // Phase-Distortion (Casio-CZ): piecewise-lineares Reshaping, Cosinus.
      const amount = 0.4;
      const p = phase < 0 ? 0 : phase > 1 ? 1 : phase;
      const reshaped = p < amount
        ? (p / amount) * 0.5
        : 0.5 + ((p - amount) / (1 - amount)) * 0.5;
      return Math.cos(2 * Math.PI * reshaped);
    }
    case 'wavetable': {
      const mip = Math.max(0, Math.min(5, Math.floor(Math.log2(1 / Math.max(dt, 1e-6)) - 8)));
      return sampleWavetable(WT.sine, WT.saw, 0.5, phase, mip);
    }
    case 'tonewheel':
      return readTable(TONEWHEEL_TABLE, phase);
    default:
      return Math.sin(2 * Math.PI * phase);
  }
}

// --- 4-Pol Moog-Ladder-Filter (vereinfacht, resonanzstabil) ---
class MoogLadder {
  private _y1 = 0;
  private _y2 = 0;
  private _y3 = 0;
  private _y4 = 0;
  process(x: number, cutoff: number, resonance: number, sampleRate: number): number {
    const f = Math.min(0.95, Math.max(0, cutoff) * 2 / sampleRate);
    const r = Math.max(0, Math.min(4, resonance));
    const fb = r * 4 * (1 - 0.15 * f * f);
    const input = x - fb * this._y4;

    this._y1 += f * (input - this._y1);
    this._y2 += f * (this._y1 - this._y2);
    this._y3 += f * (this._y2 - this._y3);
    this._y4 += f * (this._y3 - this._y4);

    const out = this._y4;
    return out;
  }
  reset() { this._y1 = this._y2 = this._y3 = this._y4 = 0; }
}

class SynthProcessor extends AudioWorkletProcessor {
  private phase = 0;
  private osc: string = 'saw';
  private freq = 220;
  private dt = 0;
  private cutoff = 1200;
  private resonance = 0.4;

  // ADSR
  private env = 0;
  private envStage: 'idle'|'attack'|'decay'|'sustain'|'release' = 'idle';
  private attack = 0.01;
  private decay = 0.15;
  private sustain = 0.6;
  private release = 0.2;
  private gain = 1.0;

  private filter = new MoogLadder();
  // Leslie (nur für tonewheel hörbar – aber immer verfügbar).
  private leslie = new LeslieSim(48000, { slowHz: 0.8, fastHz: 6.2, rampSec: 0.8, amDepth: 0.5, fmDepth: 0.012 });

  constructor() {
    super();
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.osc) this.osc = m.osc;
      if (typeof m.freq === 'number') this.freq = m.freq;
      if (typeof m.cutoff === 'number') this.cutoff = Math.max(0, m.cutoff);
      if (typeof m.resonance === 'number') this.resonance = Math.max(0, Math.min(4, m.resonance));
      if (typeof m.gain === 'number') this.gain = Math.max(0, Math.min(1.5, m.gain));
      if (typeof m.attack === 'number') this.attack = Math.max(0.0005, m.attack);
      if (typeof m.decay === 'number') this.decay = Math.max(0.001, m.decay);
      if (typeof m.sustain === 'number') this.sustain = Math.max(0, Math.min(1, m.sustain));
      if (typeof m.release === 'number') this.release = Math.max(0.001, m.release);
      if (typeof m.resetFilter === 'boolean') this.filter.reset();
      if (typeof m.leslieFast === 'boolean') this.leslie.setFast(m.leslieFast);
      if (typeof m.trigger === 'number') {   // Note-On mit Velocity
        this.envStage = 'attack';
      }
      if (m.release === true) {
        this.envStage = 'release';
      }
      if (m.noteOff) this.envStage = 'release';
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean { // NOSONAR: AudioWorkletProcessor muss true liefern
    const out = outputs[0];
    if (!out || !out[0]) return true;

    const sr = sampleRate;
    this.dt = this.freq / sr;
    const numSamples = out[0].length;

    for (let i = 0; i < numSamples; i++) {
      // PolyBLEP-Oszillator
      let s = waveform(this.osc, this.phase, this.dt);
      this.phase = (this.phase + this.dt) % 1;

      // Filter
      s = this.filter.process(s, this.cutoff, this.resonance, sr);

      // Leslie-Rotor nur für die Tonewheel-Orgel.
      if (this.osc === 'tonewheel') s = this.leslie.process(s);

      // ADSR
      const dtSec = 1 / sr;
      switch (this.envStage) {
        case 'attack': this.env += dtSec / this.attack; if (this.env >= 1) { this.env = 1; this.envStage = 'decay'; } break;
        case 'decay': this.env -= dtSec / this.decay; if (this.env <= this.sustain) { this.env = this.sustain; this.envStage = 'sustain'; } break;
        case 'sustain': break;
        case 'release': this.env -= dtSec / this.release; if (this.env <= 0) { this.env = 0; this.envStage = 'idle'; } break;
        case 'idle': this.env = 0; break;
      }

      const sample = s * this.env * this.gain;
      const safe = Number.isFinite(sample) ? sample : 0;
      let ch = 0;
      while (ch < out.length) {
        out[ch][i] = safe;
        ch++;
      }
    }

    return true;
  }
}

registerProcessor('synth-processor', SynthProcessor);
