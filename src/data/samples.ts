export interface AudioSample {
  id: string;
  name: string;
  category: 'bass' | 'mids' | 'highs';
  type: string; // e.g. "Kick", "Acid Bass", "Clap", "Rimshot", "Open Hat", "Shaker"
  url?: string;  // Public domain/archive.org free electronic sound preview link (if available) or synthesised synth preset name
  description: string;
  tags?: string[];
  parameters: {
    frequency?: number;
    decay?: number;
    pitchDecay?: number;
    oscillatorType?: string;
  };
}

export const PRESET_SAMPLE_DATABASE: AudioSample[] = [
  // BASS / LOWS (Emerald Green)
  {
    id: 'bass-909-kick',
    name: 'TR-909 Classic Kick',
    category: 'bass',
    type: 'Kick',
    // Synthetisch über Parameter erzeugt (kein externer Sample-Link nötig)
    description: 'The legendary punchy analog kick drum that defined the early Detroit and Berlin techno soundscapes.',
    parameters: { frequency: 55, decay: 0.4, pitchDecay: 0.05, oscillatorType: 'sine' }
  },
  {
    id: 'bass-sub-boomy',
    name: 'Sub-Sonic Boom Kick',
    category: 'bass',
    type: 'Kick',
    description: 'Deep, room-shaking warehouse bass kick with extended release for high-energy low end.',
    parameters: { frequency: 45, decay: 0.6, pitchDecay: 0.08, oscillatorType: 'triangle' }
  },
  {
    id: 'bass-acid-line',
    name: 'TB-303 Acid Sawtooth',
    category: 'bass',
    type: 'Acid Bass',
    description: 'Highly resonant, raw, distorted electronic bass synth line that drives the peak time and acid grooves.',
    parameters: { frequency: 120, decay: 0.15, oscillatorType: 'sawtooth' }
  },
  {
    id: 'bass-dub-chord',
    name: 'Deep Dub Chord Synth',
    category: 'bass',
    type: 'Sub Bass',
    description: 'Smooth, warm low-passed chord drone with deep analog tape style tape delays.',
    parameters: { frequency: 90, decay: 0.5, oscillatorType: 'square' }
  },

  // MIDS (Fuchsia / Purple)
  {
    id: 'mids-909-clap',
    name: 'TR-909 Analog Clap',
    category: 'mids',
    type: 'Clap',
    description: 'Stretching mid frequencies with a noise-burst decay to cut right through heavy low-end kicks.',
    parameters: { frequency: 1200, decay: 0.22 }
  },
  {
    id: 'mids-rimshot',
    name: 'Metallic Electro Rimshot',
    category: 'mids',
    type: 'Percussion',
    description: 'Resonant, short wooden rimshot strike mapped to add syncopation on offbeat sequences.',
    parameters: { frequency: 950, decay: 0.08 }
  },
  {
    id: 'mids-rave-stab',
    name: 'Hooover Rave Chord',
    category: 'mids',
    type: 'Synth Mid',
    description: 'Classic 90s warehouse mid-frequency chord hit with wide detuned oscillators.',
    parameters: { frequency: 320, decay: 0.35, oscillatorType: 'sawtooth' }
  },

  // HIGHS (Cyan / Blue)
  {
    id: 'highs-909-hat',
    name: 'TR-909 Open Hat',
    category: 'highs',
    type: 'Hi-Hat',
    description: 'Metallic analog open high-hat containing a rich spectrum of micro-modulated transient noise.',
    parameters: { frequency: 8000, decay: 0.14 }
  },
  {
    id: 'highs-shaker',
    name: 'Tribal Shaker Roll',
    category: 'highs',
    type: 'Hi-Hat',
    description: 'Very high frequency micro-shaker loop that adds top-end shuffle and high-velocity groove.',
    parameters: { frequency: 11000, decay: 0.04 }
  },
  {
    id: 'highs-bell',
    name: 'Resonant Acid Bell',
    category: 'highs',
    type: 'High Bells',
    description: 'Ice-cold high-pitched metallic mallet synth sound with sparkling delay echoes.',
    parameters: { frequency: 4500, decay: 0.2 }
  },

  // --- NEW CLASSIC & MODERN MACHINES ---
  // Roland TR-808
  {
    id: 'bass-808-kick',
    name: 'TR-808 Sub Kick',
    category: 'bass',
    type: 'Kick',
    description: 'The iconic deep, booming analog sub kick that revolutionized hip-hop and techno.',
    parameters: { frequency: 40, decay: 0.8, pitchDecay: 0.03, oscillatorType: 'sine' }
  },
  {
    id: 'mids-808-snare',
    name: 'TR-808 Snare',
    category: 'mids',
    type: 'Snare',
    description: 'The classic snappy analog snare drum with a distinctive noise tail.',
    parameters: { frequency: 800, decay: 0.15 }
  },
  {
    id: 'mids-808-cowbell',
    name: 'TR-808 Cowbell',
    category: 'mids',
    type: 'Percussion',
    description: 'The unmistakable metallic twin-oscillator cowbell from the 808.',
    parameters: { frequency: 800, decay: 0.12, oscillatorType: 'square' }
  },
  {
    id: 'highs-808-hat',
    name: 'TR-808 Closed Hat',
    category: 'highs',
    type: 'Hi-Hat',
    description: 'A sharp, short analog high-hat perfect for rapid 16th note sequencing.',
    parameters: { frequency: 9500, decay: 0.05 }
  },
  
  // Roland TR-8 (Modern ACB)
  {
    id: 'bass-tr8-kick',
    name: 'TR-8 Modern Peak Kick',
    category: 'bass',
    type: 'Kick',
    description: 'A highly processed, digital/analog hybrid ACB kick designed for modern mainstage techno.',
    parameters: { frequency: 52, decay: 0.45, pitchDecay: 0.06, oscillatorType: 'triangle' }
  },
  {
    id: 'mids-tr8-clap',
    name: 'TR-8 Layered Clap',
    category: 'mids',
    type: 'Clap',
    description: 'A punchy, stereo-widened clap using modern digital recreation of classic circuitry.',
    parameters: { frequency: 1300, decay: 0.25 }
  },

  // Roland SH-101
  {
    id: 'bass-sh101-sub',
    name: 'SH-101 Square Bass',
    category: 'bass',
    type: 'Acid Bass',
    description: 'A thick, solid square-wave sub bass from the classic 1982 monophonic synthesizer.',
    parameters: { frequency: 65, decay: 0.3, oscillatorType: 'square' }
  },

  // Moog Minimoog Model D
  {
    id: 'bass-minimoog-fat',
    name: 'Minimoog Fat Sub',
    category: 'bass',
    type: 'Sub Bass',
    description: 'The legendary warm, fat analog bass generated by three detuned oscillators through a ladder filter.',
    parameters: { frequency: 45, decay: 0.4, oscillatorType: 'sawtooth' }
  },

  // Korg M1
  {
    id: 'mids-m1-organ',
    name: 'M1 Organ Bass',
    category: 'mids',
    type: 'Synth Mid',
    description: 'The quintessential 90s house organ bass sound, digital and punchy.',
    parameters: { frequency: 150, decay: 0.4, oscillatorType: 'sine' }
  },

  // Elektron Analog Rytm
  {
    id: 'bass-rytm-kick',
    name: 'Rytm Analog Drive Kick',
    category: 'bass',
    type: 'Kick',
    description: 'A modern analog drum machine kick driven through analog distortion for industrial grit.',
    parameters: { frequency: 48, decay: 0.35, pitchDecay: 0.07, oscillatorType: 'sawtooth' }
  },
  {
    id: 'highs-rytm-fm-hat',
    name: 'Rytm FM Hat',
    category: 'highs',
    type: 'Hi-Hat',
    description: 'A modern metallic hi-hat generated using FM synthesis for complex, evolving top-end.',
    parameters: { frequency: 7500, decay: 0.1 }
  },

  // --- ADDITIONAL 808 & 909 KIT PIECES ---
  // TR-909 Extensions
  {
    id: 'mids-909-snare',
    name: 'TR-909 Snare',
    category: 'mids',
    type: 'Snare',
    description: 'The classic 909 snare, combining analog tone generation with a lo-fi 6-bit noise sample.',
    parameters: { frequency: 250, decay: 0.25 }
  },
  {
    id: 'mids-909-tom',
    name: 'TR-909 Low Tom',
    category: 'bass',
    type: 'Tom',
    description: 'A punchy synthesized analog tom from the 909.',
    parameters: { frequency: 90, decay: 0.4, pitchDecay: 0.05, oscillatorType: 'sine' }
  },
  {
    id: 'highs-909-ride',
    name: 'TR-909 Ride Cymbal',
    category: 'highs',
    type: 'Ride',
    description: 'The iconic 6-bit sampled ride cymbal that drives house and techno.',
    parameters: { frequency: 6000, decay: 0.6 }
  },
  {
    id: 'highs-909-crash',
    name: 'TR-909 Crash',
    category: 'highs',
    type: 'Crash',
    description: 'The legendary gritty, long-decay 909 crash cymbal.',
    parameters: { frequency: 5000, decay: 0.8 }
  },

  // TR-808 Extensions
  {
    id: 'mids-808-clap',
    name: 'TR-808 Clap',
    category: 'mids',
    type: 'Clap',
    description: 'The crispy analog handclap circuit from the 808.',
    parameters: { frequency: 1100, decay: 0.2 }
  },
  {
    id: 'mids-808-tom',
    name: 'TR-808 Mid Tom',
    category: 'mids',
    type: 'Tom',
    description: 'A resonant, tuning-adjustable analog tom typical of 808 grooves.',
    parameters: { frequency: 150, decay: 0.35, oscillatorType: 'triangle' }
  },
  {
    id: 'highs-808-cymbal',
    name: 'TR-808 Cymbal',
    category: 'highs',
    type: 'Cymbal',
    description: 'A synthetic blend of multiple square waves creating a classic electronic cymbal crash.',
    parameters: { frequency: 7000, decay: 0.5 }
  },
  {
    id: 'highs-808-openhat',
    name: 'TR-808 Open Hat',
    category: 'highs',
    type: 'Hi-Hat',
    description: 'The sizzling open hi-hat from the 808, with a long metallic decay.',
    parameters: { frequency: 9500, decay: 0.35 }
  }
];


