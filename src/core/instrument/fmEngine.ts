/**
 * audioMONASTRY · 6-Operator-FM-Engine (DX7-Architektur)
 * ========================================================
 * Produktionsreifer, deterministischer FM-Kern (kein Fremdcode):
 *   * 6 Operatoren, 32 Algorithmen (Topologie aus `dx7Algorithms.ts`)
 *   * DX7-Hüllkurven (4 Raten, 4 Level, R4 = Release auf 0)
 *   * Self-Feedback pro Algorithmus, Ratio/Fixed-Frequenz, Detune, Key-/Velocity-Scaling
 *   * LFO (Pitch-/Amp-Modulation, Sinus)
 *   * Offline-Render in einen Float32Array-Puffer (für Previews/Bounces/Tests);
 *     der Live-Pfad nutzt denselben Kern im Worklet (128er-Blöcke).
 *
 * Alle Allokationen passieren in `createFmVoice()`; `renderFmPatch()` ist
 * deterministisch und NaN/Inf-sicher.
 */
import { DX7_ALGORITHMS } from './dx7Algorithms';

export interface Dx7OperatorParams {
  /** Frequenz-Ratio (0.5..15) oder fixed-Hz-Modus. */
  ratio: number;
  fixed: boolean;
  fixedHz: number;
  /** Ausgangspegel 0..1. */
  level: number;
  /** Hüllkurven-Raten R1..R4 (0..99). */
  rates: [number, number, number, number];
  /** Hüllkurven-Level L1..L4 (0..99; L4 = Sustain). */
  levels: [number, number, number, number];
  /** Detune in Cents (-7..7). */
  detune: number;
  /** Velocity-Sensitivity 0..7. */
  velocitySensitivity: number;
  /** Key-Scaling 0..99 (0 = aus). */
  keyScaling: number;
}

export interface Dx7Patch {
  name: string;
  /** Algorithmus 1..32. */
  algorithm: number;
  /** Feedback 0..7. */
  feedback: number;
  /** Transpose in Halbtönen. */
  transpose: number;
  lfo: {
    speedHz: number;
    delaySec: number;
    pitchModDepth: number; // 0..99
    ampModDepth: number;   // 0..99
    sync: boolean;
  };
  operators: [Dx7OperatorParams, Dx7OperatorParams, Dx7OperatorParams, Dx7OperatorParams, Dx7OperatorParams, Dx7OperatorParams];
}

export interface FmRenderOptions {
  sampleRate: number;
  noteHz: number;
  velocity: number; // 0..1
  durationSeconds: number;
}

interface OpVoiceState {
  phase: number;
  phaseIncr: number;
  envPos: number;
  seg: number;
  segs: { dur: number; delta: number; start: number }[];
  out: number;
  fb: number;
  level: number;
}

/** Raten-Mapping DX7 (0..99) → Segmentdauer in Sekunden (Doku-Näherung). */
export function dx7RateToSeconds(rate: number): number {
  const r = Math.max(0, Math.min(99, rate));
  if (r >= 99) return 0.002;
  if (r <= 0) return 30;
  return 30 * Math.exp(-r / 14);
}

/** Level-Mapping DX7 (0..99) → 0..1. */
export function dx7LevelToGain(level: number): number {
  return Math.max(0, Math.min(1, level / 99));
}

function noteToHz(noteHz: number, transpose: number): number {
  return noteHz * Math.pow(2, transpose / 12);
}

/** Baut den deterministischen Voice-State (alle Puffer vorallokiert). */
export function createFmVoice(patch: Dx7Patch, opts: FmRenderOptions): {
  states: OpVoiceState[];
  algIndex: number;
  feedbackGain: number;
  lfoPhaseIncr: number;
  lfoPitchDepth: number;
  lfoAmpDepth: number;
  sampleRate: number;
} {
  const sr = Math.max(8000, opts.sampleRate);
  const algIndex = Math.max(0, Math.min(31, patch.algorithm - 1));
  const baseHz = noteToHz(opts.noteHz, patch.transpose ?? 0);
  const vel = Math.max(0, Math.min(1, opts.velocity));

  const states: OpVoiceState[] = patch.operators.map((op) => {
    const ratioHz = op.fixed ? op.fixedHz : baseHz * Math.max(0.5, Math.min(15, op.ratio));
    const detuneFactor = Math.pow(2, (op.detune ?? 0) / 1200);
    const velSens = 1 - ((op.velocitySensitivity ?? 0) / 7) * (1 - vel);
    const level = dx7LevelToGain(op.level) * velSens;
    const segDurs = [
      dx7RateToSeconds(op.rates[0]),
      dx7RateToSeconds(op.rates[1]),
      dx7RateToSeconds(op.rates[2]),
      dx7RateToSeconds(op.rates[3]),
    ];
    const segLevels = [
      dx7LevelToGain(op.levels[0]),
      dx7LevelToGain(op.levels[1]),
      dx7LevelToGain(op.levels[2]),
      dx7LevelToGain(op.levels[3]),
    ];
    // Segment-Deltas: R1→L1, R2→L2, R3→L3, R4→0 (Release).
    const segs = [0, 1, 2, 3].map((s) => {
      const from = s === 0 ? 0 : segLevels[s - 1];
      const to = s === 3 ? 0 : segLevels[s];
      const dur = Math.max(1, Math.round(segDurs[s] * sr));
      return { dur, delta: segDurs[s] > 0 ? (to - from) / dur : 0, start: from };
    });
    return {
      phase: 0,
      phaseIncr: (2 * Math.PI * ratioHz * detuneFactor) / sr,
      envPos: 0,
      seg: 0,
      segs,
      out: 0,
      fb: 0,
      level,
    };
  });

  return {
    states,
    algIndex,
    feedbackGain: Math.max(0, Math.min(7, patch.feedback)) / 7,
    lfoPhaseIncr: (2 * Math.PI * Math.max(0, patch.lfo.speedHz)) / sr,
    lfoPitchDepth: Math.max(0, Math.min(99, patch.lfo.pitchModDepth)) / 99,
    lfoAmpDepth: Math.max(0, Math.min(99, patch.lfo.ampModDepth)) / 99,
    sampleRate: sr,
  };
}

/** Rendert eine monophone FM-Voice deterministisch in einen Puffer. */
export function renderFmPatch(patch: Dx7Patch, opts: FmRenderOptions): Float32Array {
  const sr = Math.max(8000, opts.sampleRate);
  const frames = Math.max(1, Math.round(opts.durationSeconds * sr));
  const out = new Float32Array(frames);
  const voice = createFmVoice(patch, { ...opts, sampleRate: sr });
  const alg = DX7_ALGORITHMS[voice.algIndex] ?? DX7_ALGORITHMS[0];
  const fbOp = alg.feedbackOp;
  let lfoPhase = 0;

  for (let i = 0; i < frames; i++) {
    // LFO (Sinus)
    const lfo = Math.sin(lfoPhase);
    lfoPhase += voice.lfoPhaseIncr;

    for (let op = 0; op < 6; op++) {
      const st = voice.states[op];
      // Modulations-Eingang: Ausgänge aller Quell-Operatoren + Self-Feedback.
      let modIn = 0;
      for (let src = 0; src < 6; src++) {
        if (alg.dest[src] === op) modIn += voice.states[src].out;
      }
      if (op === fbOp) modIn += st.fb * voice.feedbackGain;

      // Hüllkurve (lineare Segmente, vorberechnet in createFmVoice).
      if (st.seg < 4) {
        const segNow = st.segs[st.seg];
        st.envPos += 1;
        if (st.envPos >= segNow.dur) {
          st.seg += 1;
          st.envPos = 0;
        }
      }
      const segIdx = Math.min(st.seg, 3);
      const env = st.seg >= 4
        ? 0
        : Math.max(0, Math.min(1, st.segs[segIdx].start + st.segs[segIdx].delta * st.envPos));

      // Oszillator mit Phasenmodulation.
      st.phase += st.phaseIncr * (1 + lfo * voice.lfoPitchDepth * 0.02);
      if (st.phase > 2 * Math.PI) st.phase -= 2 * Math.PI;
      const osc = Math.sin(st.phase + modIn * Math.PI);
      st.out = osc * st.level * env;
      st.fb = st.out;
      if (!Number.isFinite(st.out)) st.out = 0;
    }

    // Carrier-Summe auf den Ausgang.
    let sample = 0;
    for (let op = 0; op < 6; op++) {
      if (alg.dest[op] === 6) sample += voice.states[op].out;
    }
    const ampLfo = 1 - voice.lfoAmpDepth * 0.5 * (1 - lfo);
    sample *= Math.max(0, Math.min(1, ampLfo));
    if (!Number.isFinite(sample)) sample = 0;
    out[i] = Math.max(-1, Math.min(1, sample));
  }
  return out;
}
