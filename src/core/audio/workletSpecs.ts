/**
 * audioMONASTRY · Referenz-Worklet-Specs für den AudioGraph
 * ==========================================================
 * Reine TypeScript-Referenzprozessoren, die das DSP-Verhalten der echten
 * AudioWorklets (itSynth/eq/mastering) für den graphbasierten Pfad abbilden.
 * Die echten Worklets laufen weiterhin im Audio-Thread; diese Specs
 * ermöglichen Offline-/Testverarbeitung über denselben ProcessingPlan.
 */
import type { WorkletGraphRuntime, WorkletSpec } from './WorkletGraphRuntime';

function copyOrSilence(input: Float32Array[][], fallbackLength: number): Float32Array[] {
  const src = input[0] ?? [];
  const channels = Math.max(1, src.length);
  // Laenge aus dem tatsaechlichen Eingangssignal ableiten – nicht aus dem
  // Kontext. So funktionieren die Specs auch mit gepolsterten Bounce-Puffern.
  const length = src[0]?.length ?? fallbackLength;
  const out: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    out[ch] = new Float32Array(length);
    if (src[ch]) out[ch].set(src[ch].subarray(0, length));
  }
  return out;
}

const itSynthSpec: WorkletSpec = {
  id: 'it-synth',
  type: 'itSynthProcessor',
  inputs: 1,
  outputs: 1,
  process: (input, output, ctx) => {
    const len = ctx.bufferSize;
    const out = copyOrSilence(input, len);
    // Referenz: synthetisches Signal wird 1:1 durchgereicht (Level-Kontrolle).
    output[0] = out;
  },
};

const eq3Spec: WorkletSpec = {
  id: 'eq3',
  type: 'eqProcessor',
  inputs: 1,
  outputs: 1,
  process: (input, output, ctx) => {
    const len = ctx.bufferSize;
    const out = copyOrSilence(input, len);
    // Referenz: neutrales 3-Band-EQ (kein Gain) – DSP-Kette bleibt erhalten.
    output[0] = out;
  },
};

const masteringSpec: WorkletSpec = {
  id: 'mastering',
  type: 'masteringProcessor',
  inputs: 1,
  outputs: 1,
  process: (input, output, ctx) => {
    const out = copyOrSilence(input, ctx.bufferSize);
    // Referenz: Soft-Clipping (tanh) als Limiter-Ersatz.
    for (let ch = 0; ch < out.length; ch++) {
      for (let i = 0; i < out[ch].length; i++) out[ch][i] = Math.tanh(out[ch][i]);
    }
    output[0] = out;
  },
};

// ---------------------------------------------------------------------------
// State-behaftete Referenz-Specs (Delay/Reverb) für Bounce-Tail-Tests.
// Die Zustände sind bewusst module-global: Ein Bounce ruft vor dem Rendern
// `reset()` auf und ist damit reproduzierbar (Golden-Master-tauglich).
// ---------------------------------------------------------------------------

const DELAY_SAMPLES = 2400;
let delayBuf = new Float32Array(DELAY_SAMPLES);
let delayPos = 0;

const delaySpec: WorkletSpec = {
  id: 'delay',
  type: 'delayProcessor',
  inputs: 1,
  outputs: 1,
  process: (input, output, ctx) => {
    const out = copyOrSilence(input, ctx.bufferSize);
    const feedback = 0.4;
    const wet = 0.3;
    for (let ch = 0; ch < out.length; ch++) {
      const src = out[ch];
      for (let i = 0; i < src.length; i++) {
        const dry = src[i];
        const delayed = delayBuf[delayPos];
        delayBuf[delayPos] = dry + delayed * feedback;
        delayPos = (delayPos + 1) % DELAY_SAMPLES;
        src[i] = dry * (1 - wet) + delayed * wet;
      }
    }
    output[0] = out;
  },
  reset: () => {
    delayBuf = new Float32Array(DELAY_SAMPLES);
    delayPos = 0;
  },
};

const COMB1 = 1200;
const COMB2 = 1513;
const ALL1 = 583;
const ALL2 = 311;
let comb1 = new Float32Array(COMB1);
let comb2 = new Float32Array(COMB2);
let all1 = new Float32Array(ALL1);
let all2 = new Float32Array(ALL2);
let comb1Pos = 0;
let comb2Pos = 0;
let all1Pos = 0;
let all2Pos = 0;

const reverbSpec: WorkletSpec = {
  id: 'reverb',
  type: 'reverbProcessor',
  inputs: 1,
  outputs: 1,
  process: (input, output, ctx) => {
    const out = copyOrSilence(input, ctx.bufferSize);
    const fb = 0.6;
    const wet = 0.35;
    for (let ch = 0; ch < out.length; ch++) {
      const src = out[ch];
      for (let i = 0; i < src.length; i++) {
        const x = src[i];
        const c1out = comb1[comb1Pos];
        comb1[comb1Pos] = x + c1out * fb;
        comb1Pos = (comb1Pos + 1) % COMB1;
        const c2out = comb2[comb2Pos];
        comb2[comb2Pos] = x + c2out * fb;
        comb2Pos = (comb2Pos + 1) % COMB2;
        const diff = c1out + c2out;
        const a1read = all1[all1Pos];
        all1[all1Pos] = diff + a1read * 0.5;
        all1Pos = (all1Pos + 1) % ALL1;
        const a2read = all2[all2Pos];
        all2[all2Pos] = diff + a2read * 0.5;
        all2Pos = (all2Pos + 1) % ALL2;
        src[i] = x * (1 - wet) + (a1read + a2read) * 0.5 * wet;
      }
    }
    output[0] = out;
  },
  reset: () => {
    comb1 = new Float32Array(COMB1);
    comb2 = new Float32Array(COMB2);
    all1 = new Float32Array(ALL1);
    all2 = new Float32Array(ALL2);
    comb1Pos = comb2Pos = all1Pos = all2Pos = 0;
  },
};

export function registerReferenceWorkletSpecs(runtime: WorkletGraphRuntime): void {
  runtime.registerWorklet(itSynthSpec);
  runtime.registerWorklet(eq3Spec);
  runtime.registerWorklet(masteringSpec);
  runtime.registerWorklet(delaySpec);
  runtime.registerWorklet(reverbSpec);
}

export const REFERENCE_WORKLET_IDS = [itSynthSpec.id, eq3Spec.id, masteringSpec.id] as const;
/** State-behaftete Specs für Tail-/Determinismus-Tests (Bounce ruft reset auf). */
export const STATEFUL_REFERENCE_IDS = [delaySpec.id, reverbSpec.id] as const;
