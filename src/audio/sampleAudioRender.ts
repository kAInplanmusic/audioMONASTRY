/**
 * audioMONASTRY · Preset-Audio-Renderer (AI-P1-003 P4, aus dem Batch-Indexer)
 * ===========================================================================
 * Rendert ein Bibliotheks-Preset offline zu einem 48-kHz-Mono-WAV, damit der
 * Audio-Embedding-Indexer (`scripts/index-sample-audio-embeddings.ts`) es dem
 * CLAP-Encoder vorlegen kann.
 *
 * Maßgeblich ist der Hörproben-Pfad der App
 * (`audioEngine.previewSynthesizedSample`): derselbe Oszillatortyp und dieselbe
 * Hüllkurve (attack 0.005, decay, sustain 0.02, release 0.12, Note 8n = 0.25 s
 * bei 120 BPM). Weicht der Renderer ab, indiziert der Indexer Klänge, die die
 * App nie spielt. `pitchDecay` wird in diesem Pfad bewusst NICHT verwendet.
 *
 * Die Wellenformen werden bandbegrenzt (additiv bis Nyquist) erzeugt: ein
 * native Oszillator ist aliasfrei, ein naiver Sägezahn/Rechteck würde
 * Oberwellen falten und den Embedding-Vektor verschieben.
 */

export const RENDER_SAMPLE_RATE = 48_000;
/** 8n bei 120 BPM – identisch zu `triggerAttackRelease(freq, '8n')`. */
export const NOTE_SECONDS = 0.25;
export const ENVELOPE = { attack: 0.005, sustain: 0.02, release: 0.12 } as const;
export const OSCILLATOR_TYPES = ['sine', 'triangle', 'square', 'sawtooth'] as const;

export interface RenderParams {
  frequency?: number;
  decay?: number;
  pitchDecay?: number;
  oscillatorType?: string;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Bandbegrenzter Momentanwert der vier im App-Pfad erlaubten Wellenformen. */
export function oscillatorValue(type: string, phase: number, freq: number, sampleRate = RENDER_SAMPLE_RATE): number {
  const harmonics = Math.max(1, Math.floor(sampleRate / 2 / freq));
  switch (type) {
    case 'sawtooth': {
      let sum = 0;
      for (let k = 1; k <= harmonics; k++) sum += (k % 2 === 1 ? 1 : -1) * Math.sin(k * phase) / k;
      return (2 / Math.PI) * sum;
    }
    case 'square': {
      let sum = 0;
      for (let k = 1; k <= harmonics; k += 2) sum += Math.sin(k * phase) / k;
      return (4 / Math.PI) * sum;
    }
    case 'triangle': {
      let sum = 0;
      for (let k = 1; k <= harmonics; k += 2) sum += (k % 4 === 1 ? 1 : -1) * Math.sin(k * phase) / (k * k);
      return (8 / (Math.PI * Math.PI)) * sum;
    }
    default:
      return Math.sin(phase);
  }
}

/** Hüllkurve wie der App-Pfad: attack -> decay auf sustain -> halten -> release. */
export function envelopeValue(t: number, decay: number, noteEnd = NOTE_SECONDS): number {
  const { attack, sustain, release } = ENVELOPE;
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  if (t < attack + decay) return 1 - (1 - sustain) * ((t - attack) / decay);
  if (t <= noteEnd) return sustain;
  const rel = (t - noteEnd) / release;
  return rel >= 1 ? 0 : sustain * (1 - rel);
}

/** Normalisierte Abtastwerte (-1..1) eines Presets – ohne Container. */
export function renderPresetSamples(params: RenderParams): Float32Array {
  const freq = clamp(params.frequency ?? 220, 20, 20000);
  const decay = clamp(params.decay ?? 0.3, 0.05, 2);
  const type = (OSCILLATOR_TYPES as readonly string[]).includes(params.oscillatorType ?? '')
    ? (params.oscillatorType as string)
    : 'sine';
  const frames = Math.ceil((NOTE_SECONDS + ENVELOPE.release) * RENDER_SAMPLE_RATE);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / RENDER_SAMPLE_RATE;
    const phase = 2 * Math.PI * freq * t;
    out[i] = clamp(oscillatorValue(type, phase, freq) * envelopeValue(t, decay), -1, 1);
  }
  return out;
}

/** Rendert ein Preset zu einem 48-kHz-Mono-WAV (PCM 16 bit). */
export function renderPresetWav(params: RenderParams): Buffer {
  const samples = renderPresetSamples(params);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.round(samples[i] * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RENDER_SAMPLE_RATE, 24);
  header.writeUInt32LE(RENDER_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
