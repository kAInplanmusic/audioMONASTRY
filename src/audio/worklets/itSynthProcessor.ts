/**
 * itSynthProcessor – Sample-genauer Instrumenten-Synthesizer im AudioWorklet
 * --------------------------------------------------------------------------
 * Ersetzt die Tone.js-basierte `playSynthesisInstrument` für die
 * instrumentMONK-Engine: Analog (subtraktiv), FM, Drum (Pitch-Sweep + Noise),
 * FX (LFO/Sweep/Resonanz) sowie akustische Teilton-Synthese (additiv) werden
 * hier pro Sample berechnet – ohne JS-Thread-GC im Audio-Render-Pfad
 * (Erfüllung der AudioWorklet-Architekturphase, Aufgabe 2.0/2.1).
 *
 * Steuerung über Port-Nachrichten:
 *   { type: 'config', def: InstrumentPitchDef }        → Instrument übernehmen
 *   { type: 'noteOn', note, velocity, time? }           → Note starten (`note`=MIDI oder Name)
 *   { type: 'noteOff', time?, fast? }                   → Note freigeben / hart stoppen
 *   { type: 'param', name, value }                      → Runtime-Param setzen (gain/pan/transpose)
 *   { type: 'automate', param, value, rampTime? }       → sample-genaue Parameter-Rampe
 *        param: 'cutoff' | 'resonance' | 'modIndex' | 'gain' | 'lfoRate' | 'lfoDepth'
 *   { type: 'allNotesOff' }                             → Alle Stimmen freigeben
 *
 * Antwort (opt.): { type:'states', active, noteCount }  → für UI/Telemetrie
 */

// ---------------------------------------------------------------------------
// Parameter einer Instrumenten-Definition (alle Typen, serialisierbar)
// ---------------------------------------------------------------------------
interface InstrumentPitchDef {
  id: number;
  name: string;
  kind: 'acoustic' | 'synth' | 'fm' | 'drum' | 'fx';
  // oscillator / partials
  osc?: string;                 // OscillatorType als String
  partials?: { ratio: number; amp: number }[];
  // gemeinsam
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
  ratio?: number;               // modulator:carrier Frequenzverhältnis
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
  wobble?: number;             // LFO-Tiefe als Frequenzanteil
  noiseType?: 'white' | 'pink' | 'brown';
}

// ---------------------------------------------------------------------------
// Kleine DSP-Helfer
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

/** Wertebereich begrenzen (NaN/Inf-sicher). */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

// Residuen-Resonanzfilter (Moog-Ladder, stabil).
class ResoFilter {
  private y1 = 0;
  private y2 = 0;
  private y3 = 0;
  private y4 = 0;
  reset() { this.y1 = this.y2 = this.y3 = this.y4 = 0; }
  process(x: number, cutoff: number, resonance: number, sr: number): number {
    const f = Math.min(0.95, cutoff * 2 / sr);
    // Resonanz normalisieren: Eingangswerte (0..~15) auf Moog-stabilen Bereich 0..0.95
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

// Zufallsquelle: deterministischer xorshift32 (kein Math.random im Audio-Thread,
// reproduzierbar und ohne GC-/Timer-Einfluss).
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
// Eine polymorphe Stimme – Umsetzung der 5 Synthese-Paradigmen
// ---------------------------------------------------------------------------
class Voice {
  // aktiv/Phase
  kind: InstrumentPitchDef['kind'];
  age = 0;                       // in Samples seit noteOn
  active = true;

  // Oszillatoren: AC (carrier), FM-mod
  phase = 0;
  modPhase = 0;

  // additive Partials
  partialPhases: number[] = [];
  partialAmp: number[] = [];

  // Filter / Rauschen
  filter = new ResoFilter();
  noiseState = { b0: 0, b1: 0, b2: 0 };
  burstPhase = 0;                // multiBurst-Fraktion

  // Hüllkurve
  env = 0;
  envStage: 'attack'|'decay'|'sustain'|'release'|'idle' = 'attack';
  sustainLevel = 0.6;

  // Laufende Frequenz (für Sweep/LFO)
  baseFreq = 220;

  constructor(public def: InstrumentPitchDef, public noteMidi: number, public velocity: number) {
    this.kind = def.kind;
    const f = midiToFreq(noteMidi);
    this.baseFreq = f;
    // additiv → Partials vorinitialisieren
    if (def.kind === 'acoustic') {
      const parts = def.partials && def.partials.length ? def.partials : [{ ratio: 1, amp: 1 }];
      for (const p of parts) {
        this.partialPhases.push(0);
        this.partialAmp.push((p.amp || 0) / Math.max(1, parts.length));
      }
      // Falls Teilton fehlt, Grundton ergänzen
      if (!parts.some(p => p.ratio === 1)) { this.partialPhases.push(0); this.partialAmp.push(0.6 / Math.max(1, parts.length)); }
    }
  }

  /** next sample value, aktualisiert Hüllkurve. return muted wenn idle. */
  next( // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
    sampleRate: number,
    masterGain: number,
    transposeSemi: number,
    auto: { cutoff: number; resonance: number; modIndex: number; lfoRate: number; lfoDepth: number },
  ): number {
    const dt = 1 / sampleRate;

    // --- Hüllkurve (one-shot für Drum, sonst ADSR) ---
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

    // Frequenz (mit Transposition)
    const f = this.baseFreq * Math.pow(2, transposeSemi / 12);
    this.baseFreq = f;

    // --- Frequenz-Sweep (Drum / FX) ---
    let effFreq = f;
    if (this.kind === 'drum' || (this.kind === 'fx' && this.def.freqStartHZ && this.def.freqEndHZ)) {
      const fs = this.def.freqStartHZ ?? (this.def.freqStart ?? f);
      const fe = this.def.freqEndHZ ?? (this.def.freqEnd ?? fs * 0.4);
      const t = this.age * dt; // Sekunden
      const span = Math.max(0.001, (this.def.decay ?? 0.3));
      const k = Math.min(1, t / span);
      effFreq = fs + (fe - fs) * k;
    }

    // --- Synthese je Paradigma ---
    let sample = 0;

    if (this.kind === 'acoustic') {
      // additive Teilton-Synthese
      const ratioToHz = effFreq;
      for (let i = 0; i < this.partialPhases.length; i++) {
        this.partialPhases[i] = (this.partialPhases[i] + (ratioToHz * (i === 0 ? 1 : (this.def.partials?.[i]?.ratio ?? (i + 1)))) / sampleRate) % 1;
        sample += oscWave(this.def.osc || 'sine', this.partialPhases[i], 1 / sampleRate / effFreq) * this.partialAmp[i];
      }
    } else if (this.kind === 'synth') {
      const dt = effFreq / sampleRate;
      this.phase = (this.phase + dt) % 1;
      const raw = oscWave(this.def.osc || 'sawtooth', this.phase, dt);
      // Sample-genaue Automation: Cutoff/Resonanz aus der Rampe + Filter-LFO.
      const lfo = auto.lfoRate > 0 ? Math.sin(2 * Math.PI * (this.age * auto.lfoRate / sampleRate)) : 0;
      const cutoff = clamp(auto.cutoff * (1 + lfo * auto.lfoDepth), 20, sampleRate * 0.45);
      const filtered = this.filter.process(raw, cutoff, auto.resonance, sampleRate);
      // Mix aus Roh- und Filter-Schleife: sorgt für hörbaren Pegel + Klangfarbe.
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
        // Rauschbasierte Percussion
        let n = whiteNoise();
        if (this.def.noiseType === 'pink') n = pinkNoise(n, this.noiseState);
        if (this.def.noiseType === 'brown') { this.noiseState.b0 = (this.noiseState.b0 + n * 0.02) * 0.997; n = this.noiseState.b0 * 50; }
        sample = n;
        sample = this.filter.process(sample, this.def.noiseFilter ?? 4000, 0.5, sampleRate);
        // multiBurst: kurze Abfolge von Impulsen
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
      // Basis-Welle + optionale LFO-Modulation + Sweep
      const dt = effFreq / sampleRate;
      this.phase = (this.phase + dt) % 1;
      let s = oscWave(this.def.osc || 'sine', this.phase, dt);
      // LFO-Amplitudenmodulation (def-intern)
      const lfoRate = this.def.lfoRate ?? 0;
      if (lfoRate > 0) {
        const wob = this.def.wobble ?? 0.3;
        const lfoPhase = (this.age * lfoRate / sampleRate) % 1;
        const lfo = Math.sin(2 * Math.PI * lfoPhase);
        s *= (1 + lfo * wob);
      }
      // Sample-genaue Automation: Cutoff/Resonanz + Filter-LFO.
      const lfo = auto.lfoRate > 0 ? Math.sin(2 * Math.PI * (this.age * auto.lfoRate / sampleRate)) : 0;
      const cutoff = clamp(auto.cutoff * (1 + lfo * auto.lfoDepth), 20, sampleRate * 0.45);
      sample = this.filter.process(s, cutoff, auto.resonance, sampleRate);
    }

    // short-click für Drum-Transienten
    if (this.kind === 'drum' && this.def.click && this.age < sampleRate * 0.005) {
      sample += Math.sin(2 * Math.PI * (this.age % sampleRate) / (sampleRate * 0.005));
    }

    this.age++;

    // DSP-Sicherheit: nie NaN/Inf in den Ausgangspuffer lassen.
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
// Eigentlicher Prozessor: verwaltet eine kleine Polyphonie
// ---------------------------------------------------------------------------
const MAX_VOICES = 16;

/** Ein linearer Automations-Rampen-Zustand (sample-genau). */
interface Ramp {
  current: number;
  from: number;
  to: number;
  steps: number;
  count: number;
}

class ItSynthProcessor extends AudioWorkletProcessor {
  private voices: Voice[] = [];
  private def: InstrumentPitchDef = { id: 1, name: 'default', kind: 'synth',
    osc: 'sawtooth', cutoff: 1200, resonance: 0.4, attack: 0.01, release: 0.3 };
  private transpose = 0;

  // Sample-genaue Automation (lineare Rampen statt hörbarer Zipper-Sprünge).
  // current = Wert, der in diesem Sample an die Stimmen geht.
  private auto = {
    cutoff:   { current: 1200, from: 1200, to: 1200, steps: 0, count: 0 } as Ramp,
    resonance:{ current: 0.4,  from: 0.4,  to: 0.4,  steps: 0, count: 0 } as Ramp,
    modIndex: { current: 5,    from: 5,    to: 5,    steps: 0, count: 0 } as Ramp,
    gain:     { current: 0.8,  from: 0.8,  to: 0.8,  steps: 0, count: 0 } as Ramp,
    lfoRate:  { current: 0,    from: 0,    to: 0,    steps: 0, count: 0 } as Ramp,
    lfoDepth: { current: 0,    from: 0,    to: 0,    steps: 0, count: 0 } as Ramp,
  };
  // Wiederverwendbarer Snapshot (keine Objekt-Allokation im Hot-Path).
  private autoSnapshot = { cutoff: 1200, resonance: 0.4, modIndex: 5, lfoRate: 0, lfoDepth: 0 };
  // Wiederverwendbarer Mix-Puffer (keine Allokation pro Render-Quantum).
  private mixBuf = new Float32Array(0);

  /** Startet eine lineare Rampe für einen Parameter (in Sekunden). */
  private beginRamp(ramp: Ramp, to: number, rampTimeSec: number) {
    ramp.from = ramp.current;
    ramp.to = to;
    ramp.steps = Math.max(1, Math.round(Math.max(0, rampTimeSec) * sampleRate));
    ramp.count = 0;
  }

  /** Setzt einen Parameter sofort (ohne Rampe). */
  private setRampNow(ramp: Ramp, value: number) {
    ramp.current = ramp.from = ramp.to = value;
    ramp.steps = 0;
    ramp.count = 0;
  }

  /** Rampe um genau einen Sample-Schritt fortschreiben. */
  private stepRamp(ramp: Ramp) {
    if (ramp.count >= ramp.steps) { ramp.current = ramp.to; return; }
    ramp.count++;
    const k = ramp.count / ramp.steps;
    ramp.current = ramp.from + (ramp.to - ramp.from) * k;
  }

  /** Alle Rampen einen Sample-Schritt weiter. */
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

  /** Automation-Anforderung (clamped, NaN/Inf-sicher). */
  private automate(param: string, value: number, rampTimeSec: number) {
    if (!Number.isFinite(value)) return;
    switch (param) {
      case 'cutoff':    this.beginRamp(this.auto.cutoff, clamp(value, 20, 18000), rampTimeSec); break;
      case 'resonance': this.beginRamp(this.auto.resonance, clamp(value, 0, 16), rampTimeSec); break;
      case 'modIndex':  this.beginRamp(this.auto.modIndex, clamp(value, 0, 32), rampTimeSec); break;
      case 'gain':      this.beginRamp(this.auto.gain, clamp(value, 0, 1.5), rampTimeSec); break;
      case 'lfoRate':   this.beginRamp(this.auto.lfoRate, clamp(value, 0, 40), rampTimeSec); break;
      case 'lfoDepth':  this.beginRamp(this.auto.lfoDepth, clamp(value, 0, 1), rampTimeSec); break;
    }
  }

  /** Automation auf die Werte der aktuellen Instrument-Definition setzen. */
  private resetAutomation() {
    const d = this.def as unknown as Record<string, unknown>;
    const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
    this.setRampNow(this.auto.cutoff, num(d.cutoff ?? d.filterFreq, 1200));
    this.setRampNow(this.auto.resonance, num(d.resonance ?? d.q ?? d.filterQ, 0.4));
    this.setRampNow(this.auto.modIndex, num(d.modIndex, 5));
  }

  constructor() { // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
    super();
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      switch (m.type) {
        case 'config': // Instrumentendefinition
          if (m.def) this.def = m.def;
          this.resetAutomation();
          if (typeof m.gain === 'number') this.automate('gain', m.gain, 0.01);
          if (typeof m.transpose === 'number') this.transpose = m.transpose;
          break;
        case 'noteOn': {
          const midi = typeof m.note === 'number' ? m.note : nameToMidi(m.note);
          const v = Math.max(0, Math.min(1.5, m.velocity ?? 0.8));
          // begrenzte Polyphonie
          if (this.voices.length >= MAX_VOICES) this.voices.shift()?.release(true);
          const voice = new Voice(this.def, midi, v);
          this.voices.push(voice);
          this.postStates();
          break;
        }
        case 'noteOff':
          // letzteste Stimme freigeben (mono-artig) oder alle
          const fast = !!m.fast;
          if (m.all) { this.voices.forEach(x => x.release(fast)); }
          else {
            // neueste/älteste je nach flag; hier: letzte gestartete (oberste)
            if (this.voices.length > 0) this.voices[this.voices.length - 1].release(fast);
          }
          this.postStates();
          break;
        case 'param':
          if (m.name === 'gain') this.automate('gain', m.value, 0.005);
          if (m.name === 'transpose') this.transpose = m.value;
          if (m.name === 'cutoff') this.automate('cutoff', m.value, 0.01);
          if (m.name === 'resonance') this.automate('resonance', m.value, 0.01);
          break;
        case 'automate':
          // Sample-genaue Automation: lineare Rampe über rampTime Sekunden.
          this.automate(String(m.param ?? ''), Number(m.value), Number(m.rampTime ?? 0.02));
          break;
        case 'allNotesOff':
          this.voices.forEach(x => x.release(true));
          this.postStates();
          break;
      }
    };
  }

  private postStates() {
    this.port.postMessage({ type: 'states', active: this.voices.filter(v => v.active).length });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean { // NOSONAR: AudioWorkletProcessor muss true liefern
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const sr = sampleRate;
    const n = out[0].length;

    // Puffer für Mono-Mix (einmalig allokiert, bei Quantum-Größenwechsel erneuert)
    if (this.mixBuf.length !== n) this.mixBuf = new Float32Array(n);
    const buf = this.mixBuf;
    buf.fill(0);

    // Sample-genaue Automation: Rampe pro Sample fortschreiben, dann alle
    // Stimmen mit den aktuellen (interpolierten) Werten rendern. So liegen
    // Parameterwechsel exakt auf Sample-Grenzen – keine Zipper-Artefakte.
    let hasInactive = false;
    for (let i = 0; i < n; i++) {
      this.stepAutomation();
      const gain = this.auto.gain.current;
      for (const v of this.voices) {
        if (v.active) {
          buf[i] += v.next(sr, gain, this.transpose, this.autoSnapshot);
        } else {
          hasInactive = true;
        }
      }
    }

    // Tote Stimmen nur entfernen, wenn in DIESEM Quantum eine Stimme inaktiv
    // wurde – kein Array-Filter pro 128 Samples (GC-Vermeidung im Audio-Thread).
    if (hasInactive) this.voices = this.voices.filter(v => v.active);

    // Stereo ausgeben (hier einfacher Mono-Dup — Panning in der UI/Engine)
    for (let ch = 0; ch < out.length; ch++) {
      const target = out[ch];
      for (let i = 0; i < n; i++) target[i] = buf[i];
    }

    return true;
  }
}

// ---------------------------------------------------------------------------
// Helfer: MIDI <-> Frequenz / Notenname
// ---------------------------------------------------------------------------
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function nameToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim());
  if (!m) return 60;
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const semi = names.indexOf(m[1].toUpperCase() + m[2]);
  if (semi < 0) return 60;
  return 12 + (Number.parseInt(m[3], 10) + 1) * 12 + semi;
}

registerProcessor('it-synth-processor', ItSynthProcessor);
