/**
 * audioMONASTRY · ItSynthVoice / ItSynthBank
 * ============================================================
 * Pure, allocation-free synthesis voice and polyphonic bank.
 * Extracted from itSynthProcessor.ts for use in V2 Synth (RT-AUDIT-P0-006).
 */

export interface InstrumentPitchDef {
  id: number;
  name: string;
  kind: 'acoustic' | 'synth' | 'fm' | 'drum' | 'fx';
  // oscillator / partials
  osc?: string;                 // OscillatorType as string
  partials?: { ratio: number; amp: number }[];
  // envelope
  attack?: number;
  release?: number;
  sustain?: number;
  decay?: number;
  // filter
  filterType?: string;
  cutoff?: number;
  resonance?: number;
  q?: number;
  // fm
  modulatorOsc?: string;
  modIndex?: number;
  ratio?: number;               // modulator:carrier frequency ratio
  // drum
  freqStart?: number;
  freqEnd?: number;
  noise?: boolean;
  noiseFilter?: number;
  multiBurst?: boolean;
  click?: boolean;
  // fx
  lfoRate?: number;
  freq?: number;
  freqStartHZ?: number;
  freqEndHZ?: number;
  wobble?: number;             // LFO depth as frequency portion
  noiseType?: 'white' | 'pink' | 'brown';
}

// ---------------------------------------------------------------------------
// Small DSP helpers (no allocation)
// ---------------------------------------------------------------------------
function polyBLEP(t: number, dt: number): number {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  else if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

function oscWave(type: string, phase: number, dt: number): number {
  switch (type) {
    case 'saw': return (2 * phase - 1) - polyBLEP(phase, dt);
    case 'square': return (phase < 0.5 ? 1 : -1) + polyBLEP(phase, dt) - polyBLEP((phase + 0.5) % 1, dt);
    case 'triangle': return 4 * Math.abs(phase - 0.5) - 1;
    case 'sine': default: return Math.sin(2 * Math.PI * phase);
  }
}

/** Clamp value (NaN/Inf safe). */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Moog-ladder resonant filter (stable).
 */
class ResoFilter {
  private y1 = 0;
  private y2 = 0;
  private y3 = 0;
  private y4 = 0;
  reset() { this.y1 = this.y2 = this.y3 = this.y4 = 0; }
  process(x: number, cutoff: number, resonance: number, sr: number): number {
    const f = Math.min(0.95, cutoff * 2 / sr);
    const r = Math.max(0, Math.min(0.95, resonance / 16));
    const fb = r * 4 * (1 - 0.15 * f * f);
    const input = x - fb * this.y4;
    this.y1 += f * (input - this.y1);
    this.y2 += f * (this.y1 - this.y2);
    this.y3 += f * (this.y2 - this.y3);
    this.y4 += f * (this.y3 - this.y4);
    return this.y4;
  }
}

// ---------------------------------------------------------------------------
// Noise sources (deterministic, no Math.random)
// ---------------------------------------------------------------------------
let noiseState = 0x9e3779b9 >>> 0;
function whiteNoise(): number {
  noiseState ^= noiseState << 13;
  noiseState ^= noiseState >>> 17;
  noiseState ^= noiseState << 5;
  return ((noiseState >>> 0) / 4294967296) * 2 - 1;
}
function pinkNoise(x: number, state: { b0: number; b1: number; b2: number }): number {
  const w = whiteNoise();
  state.b0 = 0.99765 * state.b0 + w * 0.0990460;
  state.b1 = 0.96300 * state.b1 + w * 0.2965164;
  state.b2 = 0.57000 * state.b2 + w * 1.0526913;
  return state.b0 + state.b1 + state.b2 + w * 0.1848;
}

// ---------------------------------------------------------------------------
// One voice – implements all synthesis paradigms
// ---------------------------------------------------------------------------
class Voice {
  // active/phase
  kind: InstrumentPitchDef['kind'];
  age = 0;                       // in samples since noteOn
  active = true;

  // oscillators: AC (carrier), FM-mod
  phase = 0;
  modPhase = 0;

  // additive partials
  partialPhases: number[] = [];
  partialAmp: number[] = [];

  // filter / noise
  filter = new ResoFilter();
  noiseState = { b0: 0, b1: 0, b2: 0 };
  burstPhase = 0;                // multiBurst fraction

  // envelope
  env = 0;
  envStage: 'attack' | 'decay' | 'sustain' | 'release' | 'idle' = 'attack';
  sustainLevel = 0.6;

  // running frequency (for sweep/LFO)
  baseFreq = 220;

  constructor(def: InstrumentPitchDef, noteMidi: number, velocity: number) {
    this.kind = def.kind;
    const f = midiToFreq(noteMidi);
    this.baseFreq = f;
    // additive → partials pre-initialized
    if (def.kind === 'acoustic') {
      const parts = def.partials && def.partials.length ? def.partials : [{ ratio: 1, amp: 1 }];
      for (const p of parts) {
        this.partialPhases.push(0);
        this.partialAmp.push((p.amp || 0) / Math.max(1, parts.length));
      }
      // If no partial ratio 1, add fundamental
      if (!parts.some(p => p.ratio === 1)) {
        this.partialPhases.push(0);
        this.partialAmp.push(0.6 / Math.max(1, parts.length));
      }
    }
  }

  /** next sample value, updates envelope. Returns 0 when idle. */
  next(
    sampleRate: number,
    masterGain: number,
    transposeSemi: number,
    auto: { cutoff: number; resonance: number; modIndex: number; lfoRate: number; lfoDepth: number }
  ): number {
    const dt = 1 / sampleRate;

    // --- Envelope (one-shot for Drum, else ADSR) ---
    const a = (this.def.attack ?? 0.01);
    const r = (this.def.release ?? 0.3);
    const d = (this.def.decay ?? 0.2);
    switch (this.envStage) {
      case 'attack': this.env += dt / Math.max(0.0005, a); if (this.env >= 1) { this.env = 1; this.envStage = 'decay'; } break;
      case 'decay': this.env -= dt / Math.max(0.001, d); if (this.env <= this.sustainLevel) { this.env = this.sustainLevel; this.envStage = 'sustain'; } break;
      case 'sustain': break;
      case 'release': this.env -= dt / Math.max(0.001, r); if (this.env <= 0) { this.env = 0; this.envStage = 'idle'; this.active = false; } break;
      case 'idle': return 0;
    }

    // Frequency (with transposition).
    const f = this.baseFreq * Math.pow(2, transposeSemi / 12);

    // --- Frequency sweep (Drum / FX) ---
    let effFreq = f;
    if (this.kind === 'drum' || (this.kind === 'fx' && this.def.freqStartHZ && this.def.freqEndHZ)) {
      const fs = this.def.freqStartHZ ?? (this.def.freqStart ?? f);
      const fe = this.def.freqEndHZ ?? (this.def.freqEnd ?? fs * 0.4);
      const t = this.age * dt; // seconds
      const span = Math.max(0.001, (this.def.decay ?? 0.3));
      const k = Math.min(1, t / span);
      effFreq = fs + (fe - fs) * k;
    }

    // --- Synthesis per paradigm ---
    let sample = 0;

    if (this.kind === 'acoustic') {
      // additive partial-tone synthesis
      const ratioToHz = effFreq;
      for (let i = 0; i < this.partialPhases.length; i++) {
        this.partialPhases[i] = (this.partialPhases[i] + (ratioToHz * (i === 0 ? 1 : (this.def.partials?.[i]?.ratio ?? (i + 1)))) / sampleRate) % 1;
        sample += oscWave(this.def.osc || 'sine', this.partialPhases[i], 1 / sampleRate / effFreq) * this.partialAmp[i];
      }
    } else if (this.kind === 'synth') {
      const dt = effFreq / sampleRate;
      this.phase = (this.phase + dt) % 1;
      const raw = oscWave(this.def.osc || 'sawtooth', this.phase, dt);
      // sample‑precise automation: cutoff/resonance from ramp + LFO.
      const lfo = auto.lfoRate > 0 ? Math.sin(2 * Math.PI * (this.age * auto.lfoRate / sampleRate)) : 0;
      const cutoff = clamp(auto.cutoff * (1 + lfo * auto.lfoDepth), 20, sampleRate * 0.45);
      const filtered = this.filter.process(raw, cutoff, auto.resonance, sampleRate);
      // mix of raw and filtered: audible level + timbre.
      const wet = Math.min(0.9, Math.max(0.15, cutoff / 8000));
      sample = raw * (1 - wet) + filtered * wet;
    } else if (this.kind === 'fm') {
      const modFreq = effFreq * (this.def.ratio ?? 2);
      this.modPhase = (this.modPhase + modFreq / sampleRate) % 1;
      const mi = auto.modIndex;
      const mod = Math.sin(2 * Math.PI * this.modPhase) * mi;
      this.phase = (this.phase + (effFreq + mod * effFreq) / sampleRate) % 1;
      sample = oscWave(this.def.osc || 'sine', this.phase, 1 / sampleRate / effFreq);
    } else if (this.kind === 'drum') {
      if (this.def.noise) {
        // noise‑based percussion
        let n = whiteNoise();
        if (this.def.noiseType === 'pink') n = pinkNoise(n, this.noiseState);
        if (this.def.noiseType === 'brown') { this.noiseState.b0 = (this.noiseState.b0 + n * 0.02) * 0.997; n = this.noiseState.b0 * 50; }
        sample = n;
        sample = this.filter.process(sample, this.def.noiseFilter ?? 4000, 0.5, sampleRate);
        // multiBurst: short burst of impulses
        if (this.def.multiBurst) {
          const ticks = Math.floor(this.age / (sampleRate * 0.02)) % 3 === 0 ? 1 : 0;
          sample *= (ticks * 0.5 + 0.5);
        }
      } else {
        const dt = effFreq / sampleRate;
        this.phase = (this.phase + dt) % 1;
        sample = Math.sin(2 * Math.PI * this.phase);
        sample = this.filter.process(sample, clamp(auto.cutoff, 40, sampleRate * 0.45), auto.resonance, sampleRate);
      }
    } else { // fx
      // base wave + optional LFO modulation + sweep
      const dt = effFreq / sampleRate;
      this.phase = (this.phase + dt) % 1;
      let s = oscWave(this.def.osc || 'sine', this.phase, dt);
      // LFO amplitude modulation (internal to def)
      const lfoRate = this.def.lfoRate ?? 0;
      if (lfoRate > 0) {
        const wob = this.def.wobble ?? 0.3;
        const lfoPhase = (this.age * lfoRate / sampleRate) % 1;
        const lfo = Math.sin(2 * Math.PI * lfoPhase);
        s *= (1 + lfo * wob);
      }
      // sample‑precise automation: cutoff/resonance + filter‑LFO.
      const lfo = auto.lfoRate > 0 ? Math.sin(2 * Math.PI * (this.age * auto.lfoRate / sampleRate)) : 0;
      const cutoff = clamp(auto.cutoff * (1 + lfo * auto.lfoDepth), 20, sampleRate * 0.45);
      sample = this.filter.process(s, cutoff, auto.resonance, sampleRate);
    }

    // short‑click for drum transients
    if (this.kind === 'drum' && this.def.click && this.age < sampleRate * 0.005) {
      sample += Math.sin(2 * Math.PI * (this.age % sampleRate) / (sampleRate * 0.005));
    }

    this.age++;

    // DSP safety: never NaN/Inf in output buffer.
    const out = sample * this.env * this.velocity * masterGain;
    return Number.isFinite(out) ? out : 0;
  }

  release(fast = false): void {
    if (this.envStage === 'idle' || this.envStage === 'release') return;
    this.envStage = 'release';
    if (fast) { this.env = Math.min(this.env, 0.0001); }
  }
}

// ---------------------------------------------------------------------------
// Helper: MIDI <-> frequency / note name
// ---------------------------------------------------------------------------
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function nameToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\\d)$/.exec(name.trim());
  if (!m) return 60;
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const semi = names.indexOf(m[1].toUpperCase() + m[2]);
  if (semi < 0) return 60;
  return 12 + (Number.parseInt(m[3], 10) + 1) * 12 + semi;
}

/**
 * Sample-rate wrapper for AudioWorklet global `sampleRate`.
 * In AudioWorklet scope, `sampleRate` is a global constant.
 * In tests/Node, we fall back to 48000.
 */
function getSampleRate(): number {
  // eslint-disable-next-line no-undef
  return typeof sampleRate === 'number' ? sampleRate : 48000;
}

// ---------------------------------------------------------------------------
// Linear automation ramp state (sample‑accurate)
// ---------------------------------------------------------------------------
interface Ramp {
  current: number;
  from: number;
  to: number;
  steps: number;
  count: number;
}

/**
 * Polyphonic voice bank – fixed size, allocation‑free render.
 * Mirrors the automation & voice‑management of ItSynthProcessor.
 */
export class ItSynthBank {
  private readonly voices: Voice[];
  private def: InstrumentPitchDef = {
    id: 1,
    name: 'default',
    kind: 'synth',
    osc: 'sawtooth',
    cutoff: 1200,
    resonance: 0.4,
    attack: 0.01,
    release: 0.3,
  };
  private transpose = 0;

  // sample‑accurate automation (linear ramps instead of audible zipper jumps)
  private auto = {
    cutoff:   { current: 1200, from: 1200, to: 1200, steps: 0, count: 0 } as Ramp,
    resonance:{ current: 0.4,  from: 0.4,  to: 0.4,  steps: 0, count: 0 } as Ramp,
    modIndex: { current: 5,    from: 5,    to: 5,    steps: 0, count: 0 } as Ramp,
    gain:     { current: 0.8,  from: 0.8,  to: 0.8,  steps: 0, count: 0 } as Ramp,
    lfoRate:  { current: 0,    from: 0,    to: 0,    steps: 0, count: 0 } as Ramp,
    lfoDepth: { current: 0,    from: 0,    to: 0,    steps: 0, count: 0 } as Ramp,
  };
  // reusable snapshot (no object allocation in hot path)
  private autoSnapshot = { cutoff: 1200, resonance: 0.4, modIndex: 5, lfoRate: 0, lfoDepth: 0 };
  // reusable mix buffer (no allocation per render quantum)
  private mixBuf: Float32Array = new Float32Array(0);

  private static readonly MAX_VOICES = 16;

  constructor() {
    this.voices = new Array<Voice>(ItSynthBank.MAX_VOICES).fill(null) as Voice[];
  }

  /** Configure the instrument definition. */
  config(def: InstrumentPitchDef): void {
    this.def = def;
    this.resetAutomation();
    if (typeof def.gain === 'number') this.automate('gain', def.gain, 0.01);
    if (typeof def.transpose === 'number') this.transpose = def.transpose;
  }

  /** Start a voice. */
  noteOn(note: number | string, velocity: number): void {
    const midi = typeof note === 'number' ? note : nameToMidi(note);
    const vel = Math.max(0, Math.min(1.5, velocity ?? 0.8));
    // find first free slot
    let slot = -1;
    for (let i = 0; i < this.voices.length; i++) {
      if (!this.voices[i]) { slot = i; break; }
    }
    if (slot === -1) {
      // voice stealing: oldest active voice (first in array)
      slot = 0;
      // release the voice being stolen
      this.voices[slot]?.release(true);
    }
    this.voices[slot] = new Voice(this.def, midi, vel);
  }

  /** Release a voice (by note or all). */
  noteOff(note?: number | string, fast = false): void {
    if (note === undefined) {
      // all notes off
      for (let i = 0; i < this.voices.length; i++) {
        this.voices[i]?.release(fast);
      }
      return;
    }
    const midi = typeof note === 'number' ? note : nameToMidi(note);
    // simple: release first voice matching note (could be polyphonic per note)
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v && v.active) {
        // we don't store note per voice; approximate by releasing one voice
        v.release(fast);
        break; // release only one voice per call (mono‑like) – matches original behavior
      }
    }
  }

  /** Release all voices immediately. */
  allNotesOff(): void {
    for (let i = 0; i < this.voices.length; i++) {
      this.voices[i]?.release(true);
    }
  }

  /** Sample‑accurate automation ramp. */
  automate(param: string, value: number, rampTimeSec: number): void {
    if (!Number.isFinite(value)) return;
    switch (param) {
      case 'cutoff':
        this.beginRamp(this.auto.cutoff, clamp(value, 20, 18000), rampTimeSec);
        break;
      case 'resonance':
        this.beginRamp(this.auto.resonance, clamp(value, 0, 16), rampTimeSec);
        break;
      case 'modIndex':
        this.beginRamp(this.auto.modIndex, clamp(value, 0, 32), rampTimeSec);
        break;
      case 'gain':
        this.beginRamp(this.auto.gain, clamp(value, 0, 1.5), rampTimeSec);
        break;
      case 'lfoRate':
        this.beginRamp(this.auto.lfoRate, clamp(value, 0, 40), rampTimeSec);
        break;
      case 'lfoDepth':
        this.beginRamp(this.auto.lfoDepth, clamp(value, 0, 1), rampTimeSec);
        break;
    }
  }

  /** Set automation instantly (no ramp). */
  private setRampNow(ramp: Ramp, value: number) {
    ramp.current = ramp.from = ramp.to = value;
    ramp.steps = 0;
    ramp.count = 0;
  }

  /** Begin a linear ramp. */
  private beginRamp(ramp: Ramp, to: number, rampTimeSec: number) {
    ramp.from = ramp.current;
    ramp.to = to;
    ramp.steps = Math.max(1, Math.round(Math.max(0, rampTimeSec) * getSampleRate()));
    ramp.count = 0;
  }

  /** Step a ramp by one sample. */
  private stepRamp(ramp: Ramp) {
    if (ramp.count >= ramp.steps) { ramp.current = ramp.to; return; }
    ramp.count++;
    const k = ramp.count / ramp.steps;
    ramp.current = ramp.from + (ramp.to - ramp.from) * k;
  }

  /** Step all automations one sample. */
  private stepAutomation() {
    this.stepRamp(this.auto.cutoff);
    this.stepRamp(this.auto.resonance);
    this.stepRamp(this.auto.modIndex);
    this.stepRamp(this.auto.gain);
    this.stepRamp(this.auto.lfoRate);
    this.stepRamp(this.auto.lfoDepth);
    this.autoSnapshot.cutoff = this.auto.cutoff.current;
    this.autoSnapshot.resonance = this.auto.resonance.current;
    this.autoSnapshot.modIndex = this.auto.modIndex.current;
    this.autoSnapshot.lfoRate = this.auto.lfoRate.current;
    this.autoSnapshot.lfoDepth = this.auto.lfoDepth.current;
  }

  /** Reset automation to current instrument defaults. */
  private resetAutomation() {
    const d = this.def as unknown as Record<string, unknown>;
    const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
    this.setRampNow(this.auto.cutoff, num(d.cutoff ?? d.filterFreq, 1200));
    this.setRampNow(this.auto.resonance, num(d.resonance ?? d.q ?? d.filterQ, 0.4));
    this.setRampNow(this.auto.modIndex, num(d.modIndex, 5));
  }

  /** Render a block of samples into the provided output buffer (mono). */
  renderBlock(output: Float32Array): void {
    const n = output.length;
    if (this.mixBuf.length !== n) this.mixBuf = new Float32Array(n);
    const buf = this.mixBuf;
    buf.fill(0);

    const sr = getSampleRate(); // use global sampleRate (AudioWorkletProcessor.sampleRate)
    let hasInactive = false;
    for (let i = 0; i < n; i++) {
      this.stepAutomation();
      const gain = this.auto.gain.current;
      for (const v of this.voices) {
        if (v && v.active) {
          buf[i] += v.next(sr, gain, this.transpose, this.autoSnapshot);
        } else if (v) {
          hasInactive = true;
        }
      }
    }

    // Remove inactive voices only if any became inactive this quantum (avoid per‑128‑sample filter)
    if (hasInactive) {
      let write = 0;
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        if (v && v.active) {
          if (write !== i) this.voices[write] = v;
          write++;
        }
      }
      for (let i = write; i < this.voices.length; i++) {
        this.voices[i] = null;
      }
    }

    // Output mono (stereo duplication handled elsewhere)
    for (let i = 0; i < n; i++) {
      output[i] = buf[i];
    }
  }


  /** Returns true if any voice in the bank is currently active (has not yet released). */
  hasActiveVoices(): boolean {
    for (const v of this.voices) {
      if (v && v.active) return true;
    }
    return false;
  }

  /** SharedArrayBuffer not needed; voice bank lives on main thread. */
}