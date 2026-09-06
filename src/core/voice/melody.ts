/**
 * audioMONASTRY · VoiceMONK Melodie-Synth (künstlicher Gesang)
 * =============================================================
 * Rendert Noten (lyric + midi) als deterministische WAV-Melodie.
 */

export interface MelodyNote {
  lyric: string;
  midi: number;
  durationBeats?: number;
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function renderMelodyWav(
  notes: MelodyNote[],
  bpm: number,
  sampleRate = 22050,
): Blob {
  const beatSeconds = 60 / Math.max(20, bpm);
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bewusst beibehalten (Runde 3)
  const frames: number[] = [];
  const totalBeats = notes.reduce((sum, n) => sum + (n.durationBeats ?? 1), 0);
  const totalSamples = Math.ceil(sampleRate * beatSeconds * totalBeats);
  const samples = new Float32Array(totalSamples);

  let offset = 0;
  for (const note of notes) {
    const beats = note.durationBeats ?? 1;
    const length = Math.ceil(sampleRate * beatSeconds * beats);
    const freq = midiToFrequency(Math.max(0, Math.min(127, note.midi)));
    for (let i = 0; i < length && offset + i < totalSamples; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t * 40) * Math.min(1, (length - i) / sampleRate * 12);
      samples[offset + i] = Math.sin(2 * Math.PI * freq * t) * env * 0.5;
    }
    offset += length;
  }

  // WAV/PCM-Encoder (16-bit mono).
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s * 32767, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Vokal-Formanten (F1/F2) für eine künstliche Singstimme. */
const VOWEL_FORMANTS: Record<string, [number, number]> = {
  a: [800, 1150],
  e: [400, 2000],
  i: [300, 2200],
  o: [500, 900],
  u: [350, 800],
};

function detectVowel(lyric: string): string {
  const l = lyric.toLowerCase();
  for (const v of ['a', 'e', 'i', 'o', 'u']) {
    if (l.includes(v)) return v;
  }
  return 'a';
}

class Resonator {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(private b1: number, private a1: number, private a2: number) {}

  process(x: number): number {
    const y = this.b1 * (x - this.x2) - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function makeResonator(freq: number, sampleRate: number, bandwidth = 120): Resonator {
  const r = Math.exp(-Math.PI * bandwidth / sampleRate);
  const theta = 2 * Math.PI * freq / sampleRate;
  const a1 = -2 * r * Math.cos(theta);
  const a2 = r * r;
  const b1 = 1 - r;
  return new Resonator(b1, a1, a2);
}

/**
 * Künstliche Singstimme: Sägezahn-Quelle + Vibrato + zwei Formant-Resonatoren
 * pro Vokal. Deutlich stimmähnlicher als die reine Sinus-Melodie.
 */
export function renderVocalWav(
  notes: MelodyNote[],
  bpm: number,
  sampleRate = 22050,
): Blob {
  const beatSeconds = 60 / Math.max(20, bpm);
  const totalBeats = notes.reduce((sum, n) => sum + (n.durationBeats ?? 1), 0);
  const totalSamples = Math.ceil(sampleRate * beatSeconds * totalBeats);
  const samples = new Float32Array(totalSamples);

  let offset = 0;
  let phase = 0;
  for (const note of notes) {
    const beats = note.durationBeats ?? 1;
    const length = Math.ceil(sampleRate * beatSeconds * beats);
    const freq = midiToFrequency(Math.max(0, Math.min(127, note.midi)));
    const [f1, f2] = VOWEL_FORMANTS[detectVowel(note.lyric)];
    const res1 = makeResonator(f1, sampleRate, 120);
    const res2 = makeResonator(f2, sampleRate, 180);

    for (let i = 0; i < length && offset + i < totalSamples; i++) {
      const t = i / sampleRate;
      const vibrato = 1 + 0.008 * Math.sin(2 * Math.PI * 5.5 * t);
      const f = freq * vibrato;
      phase += f / sampleRate;
      if (phase > 1) phase -= Math.floor(phase);
      const saw = 2 * phase - 1;
      const source = (saw - Math.pow(saw, 3) * 0.25) * 0.5;
      const voice = res1.process(source) + res2.process(source) * 0.7;
      const env = Math.min(1, t * 50) * Math.min(1, (length - i) / sampleRate * 12);
      samples[offset + i] = Math.tanh(voice * 1.6) * env * 0.5;
    }
    offset += length;
  }

  // WAV/PCM-Encoder (16-bit mono).
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s * 32767, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
