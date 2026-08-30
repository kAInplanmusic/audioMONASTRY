/**
 * 
 * audioMONASTRY · instrumentMONK – Typmodell (Plugin #5: Instrumenten-Plugins)
 * ===========================================================================
 * Vereinheitlichtes, typisiertes Modell für alle Instrument-Typen:
 * klassische akustische Patches (additiv) + Synthesizer (Analog/FM/Drum/FX)
 * aus der NEXT-GEN-Spec. Die Engine greift über `IInstrumentBackend` darauf zu,
 * damit die Module keine konkrete AudioEngine mehr direkt anfassen.
 */

// ---------------------------------------------------------------------------
// Synthese-Paradigma Je Instrument
// ---------------------------------------------------------------------------
export type SynthKind =
  | 'acoustic'   // additive Teilton-Synthese (bestehende 50 akustischen Patches)
  | 'synth'      // subtraktiv: Oszillator → Filter → ADSR (Analog)
  | 'fm'         // FM: Carrier + Modulator
  | 'drum'       // Pitch-Sweep +/ od. Noise-Burst
  | 'fx';        // LFO-moduliert / experimentell

/** Kategorien für Browser/Navigation (deckt die 5 Spec-Gruppen ab). */
export type InstrumentCategory =
  | 'analog-synth' | 'fm-synth' | 'drums-percussion'
  | 'acoustic' | 'fx-experimental';

// ---------------------------------------------------------------------------
// Gemeinsame Basiseigenschaften
// ---------------------------------------------------------------------------
export interface InstrumentBase {
  id: number;
  key: string;
  name: string;
  kind: SynthKind;
  category: InstrumentCategory;
  /** Default-Instrument in einen (optionalen) MIDI-Program-Channel. */
  midiProgram?: number;
  /** Kurzbeschreibung / Klangcharakter (Doku/UI-Hilfe). */
  description?: string;
}

// --- Akustisch (additiv) ---
export interface AcousticDef extends InstrumentBase {
  kind: 'acoustic';
  osc: OscillatorType;
  partials: { ratio: number; amp: number }[];
  env: [number, number, number, number]; // [attack, decay, sustain, release]
  filterType: BiquadFilterType;
  filterFreq: number;
  filterQ: number;
  vibratoHz: number;
  vibratoAmt: number;
  detune: number;      // Ensemble-Spreize (Cents)
  noise: number;       // 0..1 Anblas-/Reibungsanteil
  harmonicity: number;
}

// --- Analog subtraktiv ---
export interface SynthDef extends InstrumentBase {
  kind: 'synth';
  osc: OscillatorType;
  filter: BiquadFilterType;
  cutoff: number;
  resonance: number;
  attack: number;
  release: number;
}

// --- FM ---
export interface FmDef extends InstrumentBase {
  kind: 'fm';
  carrier: OscillatorType;
  modulator: OscillatorType;
  modIndex: number;   // Modulations-Index
  attack: number;
  release: number;
}

// --- Drum / Percussion ---
export interface DrumDef extends InstrumentBase {
  kind: 'drum';
  freqStart?: number;
  freqEnd?: number;
  decay?: number;
  noise?: boolean;
  filterFreq?: number;
  multiBurst?: boolean;
  click?: boolean;
}

// --- FX / Experimentell ---
export interface FxDef extends InstrumentBase {
  kind: 'fx';
  wave: OscillatorType;
  lfoRate?: number;
  attack: number;
  release: number;
  freq?: number;      // optionale Grundfrequenz (z.B. 40 Hz Boom)
  freqStart?: number; // Sweep
  freqEnd?: number;
  noiseType?: 'white' | 'pink' | 'brown';
  resonance?: number;
}

export type InstrumentDefinition =
  | AcousticDef | SynthDef | FmDef | DrumDef | FxDef;

// ---------------------------------------------------------------------------
// Preset-/Config-Modell (speicher-/ladbar als JSON)
// ---------------------------------------------------------------------------
export interface InstrumentPreset {
  /** Instrument-Referenz. */
  instrumentId: number;
  /** Anpassbare Benutzer-Parameter (Overrides auf das Def). */
  gain: number;       // 0..~1.5 Master-Ausgang
  pan: number;        // -1..1
  transpose: number;  // Halbtöne
  velocity: number;   // 0..1 (Note-On-Stärke-Skalierung)
  label: string;
  persisted?: boolean;
}

/** Ein benannter, geladener Instrument-Kanal (für Sequencer-Zuweisung). */
export interface InstrumentChannel {
  channelId: string;      // z.B. 'inst1'..'inst8'
  preset: InstrumentPreset;
  routeTo: string;        // Ziel-Bus, z.B. 'GLOBAL_MASTER' / 'A' / 'B'
}

// ---------------------------------------------------------------------------
// Katalog-Helfer
// ---------------------------------------------------------------------------
export function categoryOf(kind: SynthKind): InstrumentCategory {
  switch (kind) {
    case 'acoustic': return 'acoustic';
    case 'synth': return 'analog-synth';
    case 'fm': return 'fm-synth';
    case 'drum': return 'drums-percussion';
    case 'fx': return 'fx-experimental';
  }
}

/** Note-Eingabe: MIDI-Nummer (60=C4) oder Namen ('C4', 'A#2'). */
export type NoteInput = number | string;
