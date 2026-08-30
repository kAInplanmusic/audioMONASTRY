/**
 * 
 * audioMONASTRY · instrumentMONK – Instrumenten-Katalog (Plugin #5)
 * ================================================================
 * Vereinheitlichter Katalog aller Instrumente:
 *  - Die 50 akustischen Patches werden aus `data/instrumentSynths` übernommen
 *    (physikalische additive Synthese) und als `AcousticDef` übertragen.
 *  - Die 50 Synthese-Presets aus der NEXT-GEN-Spec (Analog/FM/Drum/FX) werden
 *    hier definiert und umfassen die zweite, algorithmische Klangwelt.
 */
import {
  INSTRUMENT_PATCHES, InstrumentPatch,
} from '../../data/instrumentSynths';
import {
  AcousticDef, InstrumentCategory, InstrumentDefinition,
  SynthDef, FmDef, DrumDef, FxDef, categoryOf,
} from './types';

// ---------------------------------------------------------------------------
// 1) Akustische Patches → AcousticDef (Bridging, ids 1..50)
// ---------------------------------------------------------------------------
function toAcousticDef(p: InstrumentPatch): AcousticDef {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    kind: 'acoustic',
    category: 'acoustic',
    midiProgram: p.id - 1,
    description: `Akustisch (${p.family}): ${p.partials.length} Teilwellen, ${p.filterType}-Filter @ ${p.filterFreq} Hz.`,
    osc: p.osc,
    partials: p.partials,
    env: p.env,
    filterType: p.filterType,
    filterFreq: p.filterFreq,
    filterQ: p.filterQ,
    vibratoHz: p.vibratoHz,
    vibratoAmt: p.vibratoAmt,
    detune: p.detune,
    noise: p.noise,
    harmonicity: p.harmonicity,
  };
}

export const ACOUSTIC_INSTRUMENTS: AcousticDef[] = INSTRUMENT_PATCHES.map(toAcousticDef);

// ---------------------------------------------------------------------------
// 2) Synthese-Instrumente aus der NEXT-GEN-Spec
// ---------------------------------------------------------------------------
export const SYNTHESIS_INSTRUMENTS: InstrumentDefinition[] = [
  // --- KATEGORIE ANALOG SYNTHESIZER (synth) ---
  { id: 101, key: 'synth-juno60-pad',     name: 'Juno-60 Classic Pad', kind: 'synth', category: 'analog-synth', midiProgram: 0,  osc: 'sawtooth', filter: 'lowpass', cutoff: 1200, resonance: 4,  attack: 0.40, release: 1.20, description: 'Klassischer warmer Poly-Synth-Pad' },
  { id: 102, key: 'synth-minimoog-lead',  name: 'Minimoog Lead',       kind: 'synth', category: 'analog-synth', midiProgram: 1,  osc: 'square',   filter: 'lowpass', cutoff: 2400, resonance: 6,  attack: 0.01, release: 0.30, description: 'Fetter Lead / Solostimme' },
  { id: 103, key: 'synth-prophet-brass',  name: 'Prophet Brass',       kind: 'synth', category: 'analog-synth', midiProgram: 2,  osc: 'sawtooth', filter: 'bandpass', cutoff: 1800, resonance: 2,  attack: 0.15, release: 0.40, description: 'Brass-artiger Synth' },
  { id: 104, key: 'synth-tb303-acid',     name: 'TB-303 Acid Bass',    kind: 'synth', category: 'analog-synth', midiProgram: 3,  osc: 'sawtooth', filter: 'lowpass', cutoff: 800,  resonance: 15, attack: 0.005, release: 0.2, description: 'Säure-Bass mit hoher Resonanz' },
  { id: 105, key: 'synth-sub-bass',       name: 'Sub Heavy Bass',      kind: 'synth', category: 'analog-synth', midiProgram: 4,  osc: 'sine',     filter: 'lowpass', cutoff: 300,  resonance: 1,  attack: 0.05, release: 0.80, description: 'Druckvoller Sub-Bass' },
  { id: 106, key: 'synth-polypluck',      name: 'PolyPluck Synth',     kind: 'synth', category: 'analog-synth', midiProgram: 5,  osc: 'triangle', filter: 'lowpass', cutoff: 3000, resonance: 1,  attack: 0.01, release: 0.25, description: 'Perkussiver Pluck' },
  { id: 107, key: 'synth-pwm-strings',    name: 'PWM Strings',         kind: 'synth', category: 'analog-synth', midiProgram: 6,  osc: 'square',   filter: 'lowpass', cutoff: 1500, resonance: 3,  attack: 0.50, release: 1.00, description: 'Pulsweiten-modulierte Streicher' },
  { id: 108, key: 'synth-supersaw',       name: 'Detuned Supersaw',    kind: 'synth', category: 'analog-synth', midiProgram: 7,  osc: 'sawtooth', filter: 'lowpass', cutoff: 4000, resonance: 2,  attack: 0.02, release: 0.50, description: 'Breiter, detuneter Super-Saw' },
  { id: 109, key: 'synth-square-organ',   name: 'Square Organ',        kind: 'synth', category: 'analog-synth', midiProgram: 8,  osc: 'square',   filter: 'lowpass', cutoff: 2000, resonance: 1,  attack: 0.01, release: 0.05, description: 'Orgel-artig, hell' },
  { id: 110, key: 'synth-chiptune',       name: 'Chiptune 8-Bit',      kind: 'synth', category: 'analog-synth', midiProgram: 9,  osc: 'square',   filter: 'lowpass', cutoff: 5000, resonance: 0,  attack: 0.001, release: 0.05, description: 'Retro-Pixel-Klang' },

  // --- KATEGORIE FM SYNTHESIZER (fm) ---
  { id: 111, key: 'fm-dx7-epiano',    name: 'DX7 Electric Piano',  kind: 'fm', category: 'fm-synth', midiProgram: 4,  carrier: 'sine',     modulator: 'sine',     modIndex: 5,  attack: 0.01, release: 1.50, description: 'Klassisches DX7-E-Piano' },
  { id: 112, key: 'fm-metallic-bell', name: 'FM Metallic Bell',    kind: 'fm', category: 'fm-synth', midiProgram: 5,  carrier: 'triangle', modulator: 'sawtooth', modIndex: 12, attack: 0.005, release: 2.0, description: 'Metallisch, glockig' },
  { id: 113, key: 'fm-glass-harp',    name: 'Glass Harp',          kind: 'fm', category: 'fm-synth', midiProgram: 6,  carrier: 'sine',     modulator: 'sine',     modIndex: 2,  attack: 0.10, release: 1.20, description: 'Weiche Glas-Harfe' },
  { id: 114, key: 'fm-space-pad',     name: 'Digital Space Pad',   kind: 'fm', category: 'fm-synth', midiProgram: 7,  carrier: 'sawtooth', modulator: 'triangle', modIndex: 8,  attack: 0.80, release: 2.50, description: 'Ausladender Raum-Pad' },
  { id: 115, key: 'fm-cyber-bass',    name: 'Cyber Bass',          kind: 'fm', category: 'fm-synth', midiProgram: 8,  carrier: 'square',   modulator: 'sawtooth', modIndex: 15, attack: 0.01, release: 0.30, description: 'Digitale Bass-Kante' },
  { id: 116, key: 'fm-vocal-format',  name: 'Vocal Formant Synth', kind: 'fm', category: 'fm-synth', midiProgram: 9,  carrier: 'triangle', modulator: 'square',   modIndex: 4,  attack: 0.20, release: 0.60, description: 'Vokal-artige Formanten' },
  { id: 117, key: 'fm-crystal-arp',   name: 'Crystal Arp',         kind: 'fm', category: 'fm-synth', midiProgram: 10, carrier: 'sine',     modulator: 'square',   modIndex: 10, attack: 0.01, release: 0.40, description: 'Kristallklar für Arps' },
  { id: 118, key: 'fm-alien-tx',      name: 'Alien Transmission',  kind: 'fm', category: 'fm-synth', midiProgram: 11, carrier: 'sawtooth', modulator: 'sawtooth', modIndex: 25, attack: 0.05, release: 0.90, description: 'Extrem modziert, "alien"'},
  { id: 119, key: 'fm-matrix-organ',  name: 'Matrix Organ',        kind: 'fm', category: 'fm-synth', midiProgram: 12, carrier: 'sine',     modulator: 'triangle', modIndex: 3,  attack: 0.02, release: 0.10, description: 'Organ, FM-gewürzt' },
  { id: 120, key: 'fm-quantum-lead',  name: 'Quantum Lead',        kind: 'fm', category: 'fm-synth', midiProgram: 13, carrier: 'square',   modulator: 'sine',     modIndex: 7,  attack: 0.01, release: 0.30, description: 'Hell, führend' },

  // --- KATEGORIE DRUMS & PERCUSSION (drum) ---
  { id: 121, key: 'drum-808-kick',   name: '808 Kick Drum',       kind: 'drum', category: 'drums-percussion', midiProgram: 35, freqStart: 150, freqEnd: 40,   decay: 0.5,  click: true,  description: 'Kraftsack-Kick' },
  { id: 122, key: 'drum-808-snare',  name: '808 Snare Drum',      kind: 'drum', category: 'drums-percussion', midiProgram: 38, noise: true,  filterFreq: 2500, decay: 0.2, description: 'Rauschende Snare' },
  { id: 123, key: 'drum-909-chh',    name: '909 Closed Hi-Hat',   kind: 'drum', category: 'drums-percussion', midiProgram: 42, noise: true,  filterFreq: 8000, decay: 0.05, description: 'Kurze geschlossene HH' },
  { id: 124, key: 'drum-909-ohh',    name: '909 Open Hi-Hat',     kind: 'drum', category: 'drums-percussion', midiProgram: 46, noise: true,  filterFreq: 7000, decay: 0.3, description: 'Längere offene HH' },
  { id: 125, key: 'drum-clap',       name: 'Classic Clap',        kind: 'drum', category: 'drums-percussion', midiProgram: 39, noise: true,  multiBurst: true, decay: 0.15, description: 'Mehrfach-Clap' },
  { id: 126, key: 'drum-tom-high',   name: 'Analog Tom High',     kind: 'drum', category: 'drums-percussion', midiProgram: 50, freqStart: 300, freqEnd: 120, decay: 0.25, description: 'Hohe Tom' },
  { id: 127, key: 'drum-tom-low',    name: 'Analog Tom Low',      kind: 'drum', category: 'drums-percussion', midiProgram: 41, freqStart: 180, freqEnd: 60,  decay: 0.35, description: 'Tiefe Tom' },
  { id: 128, key: 'drum-rimshot',    name: 'Industrial Rimshot',  kind: 'drum', category: 'drums-percussion', midiProgram: 37, freqStart: 800, freqEnd: 400, decay: 0.08, description: 'Schneidender Rimshot' },
  { id: 129, key: 'drum-cowbell',    name: 'Sub Cowbell',         kind: 'drum', category: 'drums-percussion', midiProgram: 56, freqStart: 587, freqEnd: 587, decay: 0.2, description: 'Satter Cowbell' },
  { id: 130, key: 'drum-vinyl-perc', name: 'Lo-Fi Vinyl Perc',    kind: 'drum', category: 'drums-percussion', midiProgram: 30, noise: true,  filterFreq: 1200, decay: 0.1, description: 'Lo-Fi-Rauschen' },

  // --- KATEGORIE AKUSTISCH & HYBRID (acoustic) – zusätzliche Sample-werkzeuge ---
  // (Die 50 physikalischen Patches sind die Kernakkustik; hier 2 Hybrid-Add-Ons.)
  { id: 131, key: 'acoustic-hybrid-piano', name: 'Hybrid Grand (Sample+Model)', kind: 'acoustic', category: 'acoustic', midiProgram: 0, osc: 'triangle', partials: [{ ratio: 1, amp: 1 }, { ratio: 2, amp: 0.5 }, { ratio: 3, amp: 0.25 }], env: [0.001, 0.4, 0, 0.35], filterType: 'lowpass', filterFreq: 5000, filterQ: 0.7, vibratoHz: 0, vibratoAmt: 0, detune: 8, noise: 0.15, harmonicity: 1, description: 'Klavier, additiv ausgebaut' },

  // --- KATEGORIE FX / EXPERIMENTAL (fx) ---
  { id: 141, key: 'fx-ai-ambient',       name: 'AI Neural Ambient',        kind: 'fx', category: 'fx-experimental', midiProgram: 90, wave: 'sine',     lfoRate: 0.2, attack: 1.5, release: 3.0,  description: 'Schwebender Neural-Ambient-Drone' },
  { id: 142, key: 'fx-glitch-gran',      name: 'Glitch Granulator',        kind: 'fx', category: 'fx-experimental', midiProgram: 91, wave: 'square',   lfoRate: 12,  attack: 0.001, release: 0.1, description: 'Zerhackte Grains' },
  { id: 143, key: 'fx-cinematic-sub',    name: 'Cinematic Sub Boom',       kind: 'fx', category: 'fx-experimental', midiProgram: 92, wave: 'sine',     freq: 40,     attack: 0.1, release: 2.5, description: 'Film-Sub-Boom' },
  { id: 144, key: 'fx-laser-sweep',      name: 'Sci-Fi Laser Sweep',       kind: 'fx', category: 'fx-experimental', midiProgram: 93, wave: 'sawtooth', freqStart: 2000, freqEnd: 100, attack: 0.01, release: 0.4, description: 'Laser-Sweep' },
  { id: 145, key: 'fx-space-drone',      name: 'Deep Space Drone',         kind: 'fx', category: 'fx-experimental', midiProgram: 94, wave: 'triangle', lfoRate: 0.5, attack: 2.0, release: 4.0, description: 'Lange Raum-Drone' },
  { id: 146, key: 'fx-vinyl-crackle',    name: 'Vinyl Crackle Pad',        kind: 'fx', category: 'fx-experimental', midiProgram: 95, wave: 'sine',     lfoRate: 0.3, attack: 0.5, release: 1.0, noiseType: 'pink', description: 'Knistern wie Schallplatte' },
  { id: 147, key: 'fx-stutter-sweep',    name: 'Stutter Sweep',            kind: 'fx', category: 'fx-experimental', midiProgram: 96, wave: 'square',   lfoRate: 8,   attack: 0.05, release: 0.3, description: 'Stottern' },
  { id: 148, key: 'fx-metallic-drone',   name: 'Resonant Metallic Drone',  kind: 'fx', category: 'fx-experimental', midiProgram: 97, wave: 'sawtooth', lfoRate: 0.1, resonance: 20, attack: 0.3, release: 2.0, description: 'Metallische Resonanz' },
  { id: 149, key: 'fx-sub-rumble',       name: 'Subterranean Rumble',      kind: 'fx', category: 'fx-experimental', midiProgram: 98, wave: 'sine',     freq: 35,     attack: 1.0, release: 3.5, description: 'Tiefer unterirdischer Rumpel' },
  { id: 150, key: 'fx-harmonic-shimmer', name: 'Harmonic Shimmer',         kind: 'fx', category: 'fx-experimental', midiProgram: 99, wave: 'triangle', lfoRate: 4,   attack: 0.2, release: 1.5, description: 'Glitzernde Obertöne' },
];

// ---------------------------------------------------------------------------
// Gesamtkatalog
// ---------------------------------------------------------------------------
export const INSTRUMENT_CATALOG: InstrumentDefinition[] = [
  ...ACOUSTIC_INSTRUMENTS,   // ids 1..50
  ...SYNTHESIS_INSTRUMENTS,  // ids 101..150
];

export function getInstrument(id: number): InstrumentDefinition | undefined {
  return INSTRUMENT_CATALOG.find((i) => i.id === id);
}

export function listByCategory(cat?: InstrumentCategory): InstrumentDefinition[] {
  return cat ? INSTRUMENT_CATALOG.filter((i) => i.category === cat) : INSTRUMENT_CATALOG;
}

/** Statistik pro Kategorie (UI/Übersicht). */
export function catalogStats(): Record<InstrumentCategory, number> {
  const out: Record<InstrumentCategory, number> = {
    'analog-synth': 0, 'fm-synth': 0, 'drums-percussion': 0, acoustic: 0, 'fx-experimental': 0,
  };
  for (const i of INSTRUMENT_CATALOG) out[i.category] = (out[i.category] ?? 0) + 1;
  return out;
}

export { categoryOf };
export type { InstrumentPatch };
