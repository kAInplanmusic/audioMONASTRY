/**
 * audioMONASTRY · NativeAudioKit (V1-Ruhestand, ARCH-V2-001)
 * ============================================================
 * Tone-kompatible Teilmenge über nativer WebAudio-API.
 *
 * Im V2-only-Betrieb ist der Live-Audiopfad:
 *   V2StudioGraph / V2LiveSink / WorkletGraphRuntime (AudioWorklet)
 * Die hier nachgebildeten Tone-Klassen dienen ausschließlich als
 * Zustands-/Verdrahtungs-Facade für die bestehende `audioEngine`-API
 * (Kanalzug-Parameter, Mastering-Kette, Instrument-Fallbacks).
 *
 * Ohne nativen AudioContext (jsdom/Tests) arbeiten alle Klassen als
 * sichere No-Op-Zustandsobjekte.
 */

const hasWindow = typeof window !== 'undefined';
const AudioCtor: (typeof AudioContext) | undefined =
  hasWindow ? (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  : undefined;

let _ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (!_ctx && AudioCtor) {
    try {
      _ctx = new AudioCtor();
    } catch {
      _ctx = null;
    }
  }
  return _ctx;
}

// ---------------------------------------------------------------------------
// Param / Node-Basis
// ---------------------------------------------------------------------------

class Param {
  value: number;
  constructor(value = 0) {
    this.value = value;
  }
  setTargetAtTime(v: number, _time?: number, _tc?: number): this {
    this.value = v;
    return this;
  }
  setValueAtTime(v: number, _time?: number): this {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, _time?: number): this {
    this.value = v;
    return this;
  }
  rampTo(v: number, _time?: number): this {
    this.value = v;
    return this;
  }
  linearRampTo(v: number, _time?: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(_time?: number): this {
    return this;
  }
}

class NodeBase {
  volume = new Param(0);
  pan = new Param(0);
  frequency = new Param(440);
  gain = new Param(0);
  Q = new Param(0);
  detune = new Param(0);
  wet = new Param(0);
  feedback = new Param(0);
  delayTime = new Param(0);
  threshold = new Param(0);
  ratio = new Param(1);
  attack = new Param(0.01);
  release = new Param(0.1);
  knee = new Param(0);
  type = 'default';

  constructor(..._args: unknown[]) {
    void _args;
  }

  connect(_dest?: unknown): this {
    return this;
  }
  disconnect(_dest?: unknown): this {
    return this;
  }
  chain(..._nodes: unknown[]): this {
    return this;
  }
  start(_time?: number): this {
    return this;
  }
  stop(_time?: number): this {
    return this;
  }
  dispose(): this {
    return this;
  }
  set(_opts?: unknown): this {
    return this;
  }
  toDestination(): this {
    return this;
  }
  sync(): this {
    return this;
  }
  unsync(): this {
    return this;
  }
  triggerAttackRelease(_note?: unknown, _duration?: unknown, _time?: number, _velocity?: number): this {
    return this;
  }
  triggerAttack(_note?: unknown, _time?: number): this {
    return this;
  }
  triggerRelease(_time?: number): this {
    return this;
  }
}

class Volume extends NodeBase {}
class Gain extends NodeBase {}
class Panner extends NodeBase {}
class FeedbackDelay extends NodeBase {}
class Compressor extends NodeBase {
  constructor(opts?: Record<string, number>) {
    super();
    if (opts) {
      if (opts.threshold !== undefined) this.threshold.value = opts.threshold;
      if (opts.ratio !== undefined) this.ratio.value = opts.ratio;
      if (opts.attack !== undefined) this.attack.value = opts.attack;
      if (opts.release !== undefined) this.release.value = opts.release;
      if (opts.knee !== undefined) this.knee.value = opts.knee;
    }
  }
}
class Limiter extends NodeBase {
  constructor(threshold?: number) {
    super();
    if (threshold !== undefined) this.threshold.value = threshold;
  }
}
class MultibandCompressor extends NodeBase {
  low = new NodeBase();
  mid = new NodeBase();
  high = new NodeBase();
  constructor(_opts?: unknown) {
    super();
  }
}
class Filter extends NodeBase {
  constructor(freq?: number | Record<string, unknown>, type = 'lowpass', _rolloff?: number) {
    super();
    if (typeof freq === 'number') {
      this.frequency.value = freq;
      this.type = type;
    } else if (freq && typeof freq === 'object') {
      const o = freq as Record<string, unknown>;
      if (typeof o.frequency === 'number') this.frequency.value = o.frequency;
      if (typeof o.type === 'string') this.type = o.type;
      if (typeof o.Q === 'number') this.Q.value = o.Q;
    }
  }
}
class Analyser extends NodeBase {
  input = new Gain(1);
  size = 256;
  constructor(_type?: string, size?: number) {
    super();
    if (size) this.size = size;
  }
  getValue(): Float32Array {
    return new Float32Array(this.size);
  }
}

// ---------------------------------------------------------------------------
// Synths / Quellen (V2-Fallback-Pfade, im V2-Betrieb nicht im Live-Signalweg)
// ---------------------------------------------------------------------------

class Oscillator extends NodeBase {
  constructor(freq?: number | OscillatorType, type: OscillatorType = 'sine') {
    super();
    if (typeof freq === 'number') this.frequency.value = freq;
    else if (typeof freq === 'string') this.type = freq;
    this.type = type;
  }
}
class Noise extends NodeBase {
  constructor(type = 'white') {
    super();
    this.type = type;
  }
}
class AmplitudeEnvelope extends NodeBase {
  constructor(attack = 0.01, _decay = 0.1, sustain = 0.5, release = 0.1) {
    super();
    this.attack.value = attack;
    this.release.value = release;
    this.gain.value = sustain;
  }
}
class SynthBase extends NodeBase {
  constructor(opts?: unknown) {
    super();
    void opts;
  }
}
class Synth extends SynthBase {}
class MembraneSynth extends SynthBase {}
class MetalSynth extends SynthBase {}
class NoiseSynth extends SynthBase {}
class MonoSynth extends SynthBase {}

class Player extends NodeBase {
  autostart = false;
  private _buffer: AudioBuffer | undefined;
  readonly buffer = {
    get: (): AudioBuffer | undefined => this._buffer,
    set: (b: AudioBuffer) => {
      this._buffer = b;
    },
  };
  constructor(bufferOrUrl?: unknown) {
    super();
    if (bufferOrUrl instanceof ToneAudioBuffer) {
      const b = bufferOrUrl.get();
      if (b) this._buffer = b;
    } else if (bufferOrUrl && typeof bufferOrUrl === 'object' && 'get' in (bufferOrUrl as object)) {
      const b = (bufferOrUrl as { get(): AudioBuffer | undefined }).get();
      if (b) this._buffer = b;
    }
  }
}

// ---------------------------------------------------------------------------
// ToneAudioBuffer (nativer decodeAudioData)
// ---------------------------------------------------------------------------

class ToneAudioBuffer {
  private buf: AudioBuffer | undefined;
  constructor(url?: string, onload?: (b: ToneAudioBuffer) => void, onerror?: (e?: unknown) => void) {
    if (url) {
      void this.load(url).then(() => onload?.(this)).catch((e) => onerror?.(e));
    } else {
      queueMicrotask(() => onload?.(this));
    }
  }
  get(): AudioBuffer | undefined {
    return this.buf;
  }
  set(buf: AudioBuffer): this {
    this.buf = buf;
    return this;
  }
  async load(url: string): Promise<this> {
    const ctx = ensureCtx();
    if (!ctx || typeof fetch !== 'function') {
      throw new Error('Kein AudioContext zum Dekodieren verfügbar');
    }
    const res = await fetch(url);
    const ab = await res.arrayBuffer();
    this.buf = await ctx.decodeAudioData(ab);
    return this;
  }
}

// ---------------------------------------------------------------------------
// Transport / Context
// ---------------------------------------------------------------------------

let _transportStart = 0;
let _transportSeconds = 0;
let _transportRunning = false;

const Transport = {
  bpm: new Param(120),
  state: 'stopped',
  position: '0:0:0',
  get seconds(): number {
    return _transportRunning && _ctx ? _ctx.currentTime - _transportStart + _transportSeconds : _transportSeconds;
  },
  set seconds(v: number) {
    _transportSeconds = v;
    _transportStart = _ctx?.currentTime ?? 0;
  },
  start(): void {
    _transportRunning = true;
    _transportStart = _ctx?.currentTime ?? 0;
    Transport.state = 'started';
  },
  stop(): void {
    _transportRunning = false;
    Transport.state = 'stopped';
  },
  pause(): void {
    _transportRunning = false;
    Transport.state = 'paused';
  },
  scheduleRepeat(): void {},
  scheduleOnce(cb: () => void, time?: number): void {
    const delaySec = Math.max(0, (time ?? 0) - context.currentTime);
    if (typeof setTimeout === 'function') {
      setTimeout(cb, Math.min(30_000, Math.max(0, delaySec * 1000)));
    } else {
      cb();
    }
  },
  cancel(): void {},
};

const context = {
  get rawContext(): AudioContext | null {
    return ensureCtx();
  },
  get currentTime(): number {
    return _ctx?.currentTime ?? 0;
  },
  get sampleRate(): number {
    return _ctx?.sampleRate ?? 48000;
  },
  get state(): string {
    return _ctx?.state ?? 'closed';
  },
  get destination(): AudioNode | Record<string, never> {
    return _ctx?.destination ?? {};
  },
  lookAhead: 0.1,
  latencyHint: 'interactive' as AudioContextLatencyCategory | string,
  async resume(): Promise<void> {
    const ctx = ensureCtx();
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* Autoplay-Gate */
      }
    }
  },
  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode | null {
    const ctx = ensureCtx();
    return ctx ? ctx.createMediaStreamSource(stream) : null;
  },
};

function now(): number {
  return context.currentTime;
}

async function start(): Promise<void> {
  await context.resume();
}

function getContext(): typeof context {
  return context;
}

const Destination: AudioNode | Record<string, never> = (() => {
  const ctx = ensureCtx();
  return ctx?.destination ?? {};
})();

// ---------------------------------------------------------------------------
// Frequenz-Umrechnung (MIDI + Notennamen)
// ---------------------------------------------------------------------------

const NOTE_INDEX: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function noteNameToMidi(note: string): number {
  const m = /^([A-Ga-g](?:#|b)?)(-?\d+)$/.exec(note.trim());
  if (!m) return 69;
  const pc = NOTE_INDEX[m[1].toUpperCase()] ?? 0;
  const octave = Number(m[2]);
  return (octave + 1) * 12 + pc;
}

class FrequencyImpl {
  private midi: number;
  constructor(note: string | number, unit?: string) {
    if (typeof note === 'number') {
      this.midi = unit === 'midi' ? note : 69 + 12 * Math.log2(note / 440);
    } else {
      this.midi = noteNameToMidi(note);
    }
  }
  toFrequency(): number {
    return midiToFreq(this.midi);
  }
}

/** Tone-kompatibel: `Tone.Frequency(note, unit)` ohne `new`. */
function Frequency(note: string | number, unit?: string): FrequencyImpl {
  return new FrequencyImpl(note, unit);
}

/** Tone-kompatibel: `Tone.Time('1m').toSeconds()` (Bar-Länge bei aktuellem BPM). */
function Time(value: string): { toSeconds(): number } {
  const m = /^(\d*\.?\d+)\s*(m|s|n|t)$/.exec(String(value).trim());
  if (m) {
    const amount = Number(m[1] || 1);
    const unit = m[2];
    const bpm = Transport.bpm.value || 120;
    const beatSec = 60 / bpm;
    if (unit === 'm') return { toSeconds: () => amount * beatSec * 4 };
    if (unit === 'n') return { toSeconds: () => amount * beatSec * (1 / 4) };
    if (unit === 't') return { toSeconds: () => amount * beatSec * (1 / 3) };
    return { toSeconds: () => amount };
  }
  return { toSeconds: () => 60 / (Transport.bpm.value || 120) * 4 };
}

// ---------------------------------------------------------------------------
// Export (Tone-kompatible Oberfläche)
// ---------------------------------------------------------------------------

export {
  // Klassen
  NodeBase,
  Param,
  Volume,
  Gain,
  Panner,
  Filter,
  FeedbackDelay,
  Compressor,
  Limiter,
  MultibandCompressor,
  Analyser,
  Oscillator,
  Noise,
  AmplitudeEnvelope,
  Synth,
  MembraneSynth,
  MetalSynth,
  NoiseSynth,
  MonoSynth,
  Player,
  ToneAudioBuffer,
  Frequency,
  Time,
  // Laufzeit
  context,
  Transport,
  Destination,
  now,
  start,
  getContext,
};
