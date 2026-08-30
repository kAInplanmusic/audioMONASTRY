// ============================================================================
// instrumentSynths.ts – Physikalischer Synthesizer-Kern (Instrumente #14)
// ----------------------------------------------------------------------------
// 50 akustische Instrumente als parametrisches Klangmodell auf Fachphysik-Basis:
//   * `partials`  – Obertonspektrum (Teilwellen, rel. Amplituden)
//   * `family`    – Grundcharakteristik (Anblas-/Anschlagverhalten)
//   * Hüllkurven, Filter, Vibrato, Breath-Noise, Detune (Ensemble-Breite)
// Wird von `audioEngine.loadInstrument(id)` in einen Tone.js-Synth umgesetzt.
// ============================================================================

export type InstrumentFamily =
  | 'keys' | 'strings' | 'pluck' | 'brass' | 'woodwind'
  | 'voice' | 'perc' | 'drone';

export interface InstrumentPatch {
  id: number;
  key: string;
  name: string;
  family: InstrumentFamily;
  osc: OscillatorType;
  partials: { ratio: number; amp: number }[];
  env: [number, number, number, number];      // [attack, decay, sustain, release] in sec
  filterType: BiquadFilterType;
  filterFreq: number;
  filterQ: number;
  vibratoHz: number;
  vibratoAmt: number;
  detune: number;            // Ensemble-Spread in Cents
  noise: number;             // 0..1 Anblas-/Reibungsanteil
  harmonicity: number;
}

function P(n: number, baseAmp = 1, damp = 0.85): { ratio: number; amp: number }[] {
  const out = [];
  for (let k = 1; k <= n; k++) out.push({ ratio: k, amp: baseAmp * Math.pow(1 / k, damp) });
  return out;
}

const STR = P(8, 1, 0.92);
const PLK = [{ratio:1,amp:1},{ratio:2,amp:0.45},{ratio:3,amp:0.25},{ratio:4,amp:0.16}];
const PERC = [{ratio:1,amp:1},{ratio:2,amp:0.6},{ratio:2.76,amp:0.45},{ratio:4.07,amp:0.3},{ratio:5.4,amp:0.18}];

export const INSTRUMENT_PATCHES: InstrumentPatch[] = [
  // ---------- Tasten (1-10) ----------
  { id:1, key:'grand-piano', name:'Grand Piano', family:'keys', osc:'triangle', partials:P(12,0.95,1.0), env:[0.002,0.4,0,0.35], filterType:'lowpass', filterFreq:5000, filterQ:0.7, vibratoHz:0, vibratoAmt:0, detune:8, noise:0.35, harmonicity:1 },
  { id:2, key:'epiano', name:'Electric Piano (Rhodes)', family:'keys', osc:'sine', partials:[{ratio:1,amp:1},{ratio:2,amp:0.4},{ratio:4.9,amp:0.25}], env:[0.003,0.3,0,0.2], filterType:'lowpass', filterFreq:4000, filterQ:0.9, vibratoHz:0, vibratoAmt:0, detune:12, noise:0.15, harmonicity:1 },
  { id:3, key:'organ', name:'Organ (Hammond B3)', family:'keys', osc:'sawtooth', partials:P(6,1,0.6), env:[0.02,0.1,1,0.05], filterType:'bandpass', filterFreq:2500, filterQ:1.4, vibratoHz:6.2, vibratoAmt:0.06, detune:6, noise:0.05, harmonicity:3 },
  { id:4, key:'harpsichord', name:'Harpsichord', family:'keys', osc:'triangle', partials:[{ratio:1,amp:1},{ratio:2,amp:0.5},{ratio:4,amp:0.3},{ratio:8,amp:0.2}], env:[0.001,0.18,0,0.09], filterType:'highpass', filterFreq:800, filterQ:0.6, vibratoHz:0, vibratoAmt:0, detune:4, noise:0.2, harmonicity:1 },
  { id:5, key:'celesta', name:'Celesta', family:'keys', osc:'sine', partials:[{ratio:1,amp:1},{ratio:4,amp:0.3},{ratio:6,amp:0.2}], env:[0.005,0.25,0,0.2], filterType:'lowpass', filterFreq:6000, filterQ:0.8, vibratoHz:0, vibratoAmt:0, detune:6, noise:0.05, harmonicity:1.2 },
  { id:6, key:'accordion', name:'Accordion', family:'keys', osc:'sawtooth', partials:P(8,1,0.95), env:[0.03,0.1,0.9,0.1], filterType:'bandpass', filterFreq:1800, filterQ:1.8, vibratoHz:6.0, vibratoAmt:0.10, detune:14, noise:0.1, harmonicity:2 },
  { id:7, key:'clavinet', name:'Clavinet', family:'keys', osc:'square', partials:[{ratio:1,amp:1},{ratio:2,amp:0.3},{ratio:3,amp:0.15}], env:[0.002,0.22,0,0.1], filterType:'bandpass', filterFreq:1200, filterQ:2.0, vibratoHz:0, vibratoAmt:0, detune:5, noise:0.25, harmonicity:1.2 },
  { id:8, key:'marimba', name:'Marimba', family:'perc', osc:'sine', partials:PERC, env:[0.001,0.35,0,0.15], filterType:'lowpass', filterFreq:3000, filterQ:0.9, vibratoHz:0, vibratoAmt:0, detune:3, noise:0.08, harmonicity:4.07 },
  { id:9, key:'vibraphone', name:'Vibraphone', family:'perc', osc:'sine', partials:PERC, env:[0.004,0.45,0,0.4], filterType:'lowpass', filterFreq:5000, filterQ:0.8, vibratoHz:5.5, vibratoAmt:0.12, detune:4, noise:0.06, harmonicity:3.7 },
  { id:10, key:'glockenspiel', name:'Glockenspiel', family:'perc', osc:'sine', partials:[{ratio:1,amp:1},{ratio:5.4,amp:0.3},{ratio:8,amp:0.18}], env:[0.001,0.5,0,0.3], filterType:'highpass', filterFreq:2500, filterQ:0.6, vibratoHz:0, vibratoAmt:0, detune:2, noise:0.04, harmonicity:5.4 },

  // ---------- Streich (11-16) ----------
  { id:11, key:'violin', name:'Violin', family:'strings', osc:'sawtooth', partials:STR, env:[0.03,0.1,0.95,0.1], filterType:'lowpass', filterFreq:4200, filterQ:1.1, vibratoHz:6.3, vibratoAmt:0.16, detune:9, noise:0.22, harmonicity:1 },
  { id:12, key:'viola', name:'Viola', family:'strings', osc:'sawtooth', partials:STR, env:[0.04,0.1,0.95,0.1], filterType:'lowpass', filterFreq:3200, filterQ:1.1, vibratoHz:6.2, vibratoAmt:0.15, detune:10, noise:0.2, harmonicity:1 },
  { id:13, key:'cello', name:'Cello', family:'strings', osc:'sawtooth', partials:STR, env:[0.05,0.1,0.95,0.12], filterType:'lowpass', filterFreq:2600, filterQ:1.2, vibratoHz:6.0, vibratoAmt:0.14, detune:12, noise:0.18, harmonicity:1 },
  { id:14, key:'contrabass', name:'Contrabass', family:'strings', osc:'sawtooth', partials:STR, env:[0.06,0.1,0.96,0.12], filterType:'lowpass', filterFreq:1500, filterQ:1.3, vibratoHz:5.5, vibratoAmt:0.12, detune:14, noise:0.16, harmonicity:1 },
  { id:15, key:'string-ensemble', name:'String Ensemble', family:'strings', osc:'sawtooth', partials:STR, env:[0.1,0.1,0.9,0.2], filterType:'lowpass', filterFreq:3500, filterQ:0.8, vibratoHz:5.8, vibratoAmt:0.18, detune:20, noise:0.2, harmonicity:1 },
  { id:16, key:'harp', name:'Harp', family:'pluck', osc:'sine', partials:STR, env:[0.01,0.4,0,0.25], filterType:'highpass', filterFreq:700, filterQ:0.5, vibratoHz:0, vibratoAmt:0, detune:8, noise:0.12, harmonicity:1 },

  // ---------- Zupf (17-24) ----------
  { id:17, key:'guitar-nylon', name:'Acoustic Guitar (Nylon)', family:'pluck', osc:'triangle', partials:PLK, env:[0.002,0.3,0,0.14], filterType:'lowpass', filterFreq:3000, filterQ:0.7, vibratoHz:0, vibratoAmt:0, detune:6, noise:0.1, harmonicity:1 },
  { id:18, key:'guitar-steel', name:'Acoustic Guitar (Steel)', family:'pluck', osc:'sawtooth', partials:PLK, env:[0.002,0.28,0,0.12], filterType:'lowpass', filterFreq:4200, filterQ:0.7, vibratoHz:0, vibratoAmt:0, detune:7, noise:0.15, harmonicity:1 },
  { id:19, key:'guitar-clean', name:'Electric Guitar (Clean)', family:'pluck', osc:'sawtooth', partials:PLK, env:[0.003,0.25,0,0.1], filterType:'bandpass', filterFreq:1800, filterQ:1.3, vibratoHz:0, vibratoAmt:0, detune:8, noise:0.08, harmonicity:1 },
  { id:20, key:'guitar-overdrive', name:'Electric Guitar (Overdrive)', family:'pluck', osc:'square', partials:P(6,1,0.9), env:[0.004,0.3,0,0.15], filterType:'lowpass', filterFreq:3000, filterQ:0.9, vibratoHz:0, vibratoAmt:0, detune:12, noise:0.1, harmonicity:1.5 },
  { id:21, key:'bass', name:'Electric Bass', family:'pluck', osc:'sawtooth', partials:P(5,1,0.85), env:[0.005,0.4,0,0.2], filterType:'lowpass', filterFreq:900, filterQ:1.0, vibratoHz:0, vibratoAmt:0, detune:9, noise:0.06, harmonicity:1 },
  { id:22, key:'banjo', name:'Banjo', family:'pluck', osc:'sawtooth', partials:[{ratio:1,amp:1},{ratio:2,amp:0.5},{ratio:3,amp:0.4},{ratio:5,amp:0.3},{ratio:10,amp:0.2}], env:[0.002,0.1,0,0.06], filterType:'highpass', filterFreq:1200, filterQ:0.7, vibratoHz:0, vibratoAmt:0, detune:5, noise:0.2, harmonicity:1.2 },
  { id:23, key:'ukulele', name:'Ukulele', family:'pluck', osc:'triangle', partials:PLK, env:[0.002,0.2,0,0.1], filterType:'lowpass', filterFreq:3500, filterQ:0.7, vibratoHz:0, vibratoAmt:0, detune:7, noise:0.1, harmonicity:1 },
  { id:24, key:'mandolin', name:'Mandolin', family:'pluck', osc:'triangle', partials:[{ratio:1,amp:1},{ratio:2,amp:0.4},{ratio:3,amp:0.28},{ratio:4,amp:0.2}], env:[0.002,0.18,0,0.08], filterType:'highpass', filterFreq:900, filterQ:0.6, vibratoHz:0, vibratoAmt:0, detune:6, noise:0.12, harmonicity:1.1 },

  // ---------- Weltmusik Zupf (25) ----------
  { id:25, key:'sitar', name:'Sitar', family:'pluck', osc:'square', partials:P(12,1,0.8), env:[0.01,0.5,0,0.3], filterType:'highpass', filterFreq:900, filterQ:0.7, vibratoHz:0, vibratoAmt:0, detune:25, noise:0.18, harmonicity:1.06 },

  // ---------- Blech (26-31) ----------
  { id:26, key:'trumpet', name:'Trumpet', family:'brass', osc:'sawtooth', partials:P(12,1,0.8), env:[0.03,0.15,0.9,0.15], filterType:'lowpass', filterFreq:4500, filterQ:1.0, vibratoHz:5.5, vibratoAmt:0.05, detune:6, noise:0.15, harmonicity:1 },
  { id:27, key:'trombone', name:'Trombone', family:'brass', osc:'sawtooth', partials:P(12,1,0.8), env:[0.04,0.15,0.9,0.16], filterType:'lowpass', filterFreq:3200, filterQ:1.1, vibratoHz:5.0, vibratoAmt:0.05, detune:7, noise:0.14, harmonicity:1 },
  { id:28, key:'french-horn', name:'French Horn', family:'brass', osc:'sawtooth', partials:P(12,1,0.8), env:[0.06,0.1,0.95,0.2], filterType:'lowpass', filterFreq:2600, filterQ:1.4, vibratoHz:4.5, vibratoAmt:0.06, detune:8, noise:0.12, harmonicity:1.05 },
  { id:29, key:'tuba', name:'Tuba', family:'brass', osc:'sawtooth', partials:P(12,1,0.8), env:[0.05,0.12,0.9,0.18], filterType:'lowpass', filterFreq:900, filterQ:1.2, vibratoHz:4.2, vibratoAmt:0.05, detune:10, noise:0.1, harmonicity:1 },
  { id:30, key:'alto-sax', name:'Saxophone (Alto)', family:'brass', osc:'sawtooth', partials:P(12,1,0.8), env:[0.04,0.15,0.88,0.15], filterType:'lowpass', filterFreq:3600, filterQ:0.9, vibratoHz:5.6, vibratoAmt:0.12, detune:8, noise:0.14, harmonicity:1 },
  { id:31, key:'tenor-sax', name:'Saxophone (Tenor)', family:'brass', osc:'sawtooth', partials:P(12,1,0.8), env:[0.05,0.16,0.85,0.16], filterType:'lowpass', filterFreq:3000, filterQ:1.0, vibratoHz:5.4, vibratoAmt:0.13, detune:9, noise:0.13, harmonicity:1 },

  // ---------- Holz (32-39) ----------
  { id:32, key:'clarinet', name:'Clarinet', family:'woodwind', osc:'sawtooth', partials:P(9,1,0.95), env:[0.05,0.12,0.9,0.12], filterType:'bandpass', filterFreq:800, filterQ:1.6, vibratoHz:5.0, vibratoAmt:0.06, detune:5, noise:0.16, harmonicity:1 },
  { id:33, key:'oboe', name:'Oboe', family:'woodwind', osc:'sawtooth', partials:P(10,1,0.95), env:[0.04,0.12,0.88,0.12], filterType:'bandpass', filterFreq:1800, filterQ:1.8, vibratoHz:5.2, vibratoAmt:0.05, detune:4, noise:0.18, harmonicity:1 },
  { id:34, key:'flute', name:'Flute', family:'woodwind', osc:'sine', partials:P(10,0.9,0.9), env:[0.06,0.12,0.92,0.14], filterType:'lowpass', filterFreq:2800, filterQ:0.8, vibratoHz:5.2, vibratoAmt:0.10, detune:4, noise:0.3, harmonicity:1 },
  { id:35, key:'piccolo', name:'Piccolo', family:'woodwind', osc:'sine', partials:P(10,0.9,0.9), env:[0.05,0.1,0.9,0.12], filterType:'highpass', filterFreq:1500, filterQ:0.8, vibratoHz:5.6, vibratoAmt:0.08, detune:3, noise:0.28, harmonicity:1 },
  { id:36, key:'bassoon', name:'Bassoon', family:'woodwind', osc:'sawtooth', partials:P(8,1,0.92), env:[0.06,0.14,0.88,0.16], filterType:'lowpass', filterFreq:1400, filterQ:1.0, vibratoHz:4.8, vibratoAmt:0.05, detune:6, noise:0.16, harmonicity:1 },
  { id:37, key:'harmonica', name:'Harmonica', family:'voice', osc:'sawtooth', partials:P(8,1,0.85), env:[0.02,0.12,0.9,0.1], filterType:'bandpass', filterFreq:2400, filterQ:1.3, vibratoHz:6.0, vibratoAmt:0.12, detune:12, noise:0.4, harmonicity:1 },
  { id:38, key:'pan-flute', name:'Pan Flute', family:'woodwind', osc:'sine', partials:P(10,0.9,0.9), env:[0.03,0.12,0.9,0.1], filterType:'lowpass', filterFreq:2500, filterQ:0.9, vibratoHz:5.4, vibratoAmt:0.10, detune:5, noise:0.2, harmonicity:1 },
  { id:39, key:'shakuhachi', name:'Shakuhachi', family:'woodwind', osc:'sawtooth', partials:P(7,1,0.9), env:[0.05,0.14,0.9,0.14], filterType:'bandpass', filterFreq:1200, filterQ:1.7, vibratoHz:4.8, vibratoAmt:0.08, detune:8, noise:0.3, harmonicity:1 },

  // ---------- Weltmusik / Chor / Perk (40-50) ----------
  { id:40, key:'kalimba', name:'Kalimba', family:'perc', osc:'sine', partials:PERC, env:[0.001,0.3,0,0.15], filterType:'lowpass', filterFreq:4000, filterQ:0.9, vibratoHz:0, vibratoAmt:0, detune:4, noise:0.05, harmonicity:4.07 },
  { id:41, key:'didgeridoo', name:'Didgeridoo', family:'drone', osc:'sawtooth', partials:P(8,1,0.8), env:[0.1,0.1,1.0,0.15], filterType:'lowpass', filterFreq:400, filterQ:2.0, vibratoHz:0, vibratoAmt:0, detune:18, noise:0.35, harmonicity:2 },
  { id:42, key:'koto', name:'Koto', family:'pluck', osc:'sawtooth', partials:P(8,1,0.9), env:[0.003,0.35,0,0.25], filterType:'highpass', filterFreq:800, filterQ:0.6, vibratoHz:4.2, vibratoAmt:0.06, detune:8, noise:0.18, harmonicity:1.06 },
  { id:43, key:'erhu', name:'Erhu', family:'strings', osc:'sawtooth', partials:STR, env:[0.05,0.12,0.9,0.15], filterType:'bandpass', filterFreq:2400, filterQ:1.5, vibratoHz:6.8, vibratoAmt:0.2, detune:14, noise:0.25, harmonicity:1.5 },
  { id:44, key:'steel-drum', name:'Steel Drum', family:'perc', osc:'sine', partials:PERC, env:[0.002,0.4,0,0.25], filterType:'lowpass', filterFreq:5000, filterQ:0.8, vibratoHz:5.0, vibratoAmt:0.06, detune:6, noise:0.05, harmonicity:2.76 },
  { id:45, key:'choir-aah', name:'Choir (Aah)', family:'voice', osc:'sawtooth', partials:P(8,1,0.85), env:[0.08,0.12,0.9,0.2], filterType:'bandpass', filterFreq:800, filterQ:1.0, vibratoHz:5.6, vibratoAmt:0.12, detune:16, noise:0.1, harmonicity:1 },
  { id:46, key:'choir-ooh', name:'Choir (Ooh)', family:'voice', osc:'sine', partials:P(6,1,0.9), env:[0.08,0.12,0.9,0.2], filterType:'lowpass', filterFreq:1200, filterQ:1.2, vibratoHz:5.5, vibratoAmt:0.1, detune:14, noise:0.08, harmonicity:1.2 },
  { id:47, key:'theremin', name:'Theremin', family:'drone', osc:'sine', partials:[{ratio:1,amp:1}], env:[0.05,0.1,0.9,0.15], filterType:'highpass', filterFreq:300, filterQ:0.6, vibratoHz:5.0, vibratoAmt:0.14, detune:6, noise:0.02, harmonicity:1 },
  { id:48, key:'bagpipe', name:'Bagpipe', family:'drone', osc:'sawtooth', partials:P(6,1,0.9), env:[0.05,0.1,1.0,0.1], filterType:'bandpass', filterFreq:900, filterQ:2.2, vibratoHz:0, vibratoAmt:0, detune:20, noise:0.2, harmonicity:1.4 },
  { id:49, key:'timpani', name:'Timpani', family:'perc', osc:'sine', partials:[{ratio:1,amp:1},{ratio:1.5,amp:0.6},{ratio:2,amp:0.4},{ratio:2.5,amp:0.3}], env:[0.002,0.6,0,0.3], filterType:'lowpass', filterFreq:2500, filterQ:0.6, vibratoHz:0, vibratoAmt:0, detune:4, noise:0.2, harmonicity:1 },
  { id:50, key:'tubular-bells', name:'Tubular Bells', family:'perc', osc:'sine', partials:[{ratio:1,amp:1},{ratio:2.76,amp:0.4},{ratio:5.4,amp:0.25}], env:[0.001,0.8,0,0.4], filterType:'highpass', filterFreq:1500, filterQ:0.6, vibratoHz:0, vibratoAmt:0, detune:2, noise:0.03, harmonicity:2.76 },
];

export function getPatch(instrumentId: number): InstrumentPatch | undefined {
  return INSTRUMENT_PATCHES.find((p) => p.id === instrumentId);
}
