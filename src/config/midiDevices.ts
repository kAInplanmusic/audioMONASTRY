// ============================================================================
// audioMONASTRY – MIDI Device-Registry (Auto-Erkennung)
// ----------------------------------------------------------------------------
// Jedes bekannte MIDI-Gerät wird über einen Fingerprint (Herstellername + Name)
// erkannt und einem 'profile' sowie einem 'type' zugeordnet. So kann das UI
// Plug-and-Play-Hardware automatisch korrekt konfigurieren und per Canvas-Skin
// darstellen (rückblickend auf Task 6).
// ============================================================================

export type MidiDeviceType =
  | 'GRID'      // Launchpad / Push / APC (Pads + Grid)
  | 'DJ'        // Pioneer DDJ / Traktor / Hercules
  | 'MPC'       // Akai MPC / Finger-Drumming
  | 'KEYBOARD'  // Piano-Controller
  | 'MIXER'     // Fader-/Mixing-Controller
  | 'PAD';      // generische Pads

export interface MidiDeviceProfile {
  profile: string;      // z. B. 'APC40' (Mapping-Profil-ID)
  type: MidiDeviceType;
  vendor: string;
  name: string;
}

export const MIDI_DEVICE_REGISTRY: MidiDeviceProfile[] = [
  // --- AKAI ---
  { profile: 'APC40',  type: 'GRID',     vendor: 'Akai',       name: 'APC40' },
  { profile: 'APC40',  type: 'GRID',     vendor: 'Akai',       name: 'LPD8' },
  { profile: 'MPC',    type: 'MPC',      vendor: 'Akai',       name: 'MPC' },
  { profile: 'MPD',    type: 'PAD',      vendor: 'Akai',       name: 'MPD' },
  { profile: 'KEYBOARD', type: 'KEYBOARD', vendor: 'Akai',     name: 'MPK' },
  // --- Ableton ---
  { profile: 'PUSH2',  type: 'GRID',     vendor: 'Ableton',    name: 'Push' },
  // --- Novation ---
  { profile: 'LAUNCHPAD', type: 'GRID',  vendor: 'Novation',   name: 'Launchpad' },
  { profile: 'KEYBOARD', type: 'KEYBOARD', vendor: 'Novation', name: 'Launchkey' },
  // --- Pioneer (DJ) ---
  { profile: 'DDJ',    type: 'DJ',       vendor: 'Pioneer',    name: 'DDJ' },
  { profile: 'REV',    type: 'DJ',       vendor: 'Pioneer',    name: 'DJREV' },
  // --- Native Instruments ---
  { profile: 'MASCHINE', type: 'PAD',    vendor: 'Native Instruments', name: 'Maschine' },
  { profile: 'TRAKTOR',   type: 'DJ',    vendor: 'Native Instruments', name: 'Traktor' },
  { profile: 'KEYBOARD',  type: 'KEYBOARD', vendor: 'Native Instruments', name: 'Komplete' },
  // --- Hercules ---
  { profile: 'INPULSE', type: 'DJ',      vendor: 'Hercules',   name: 'Inpulse' },
  { profile: 'INPULSE', type: 'GRID',    vendor: 'Hercules',   name: 'DJControl' },
  // --- Denon ---
  { profile: 'DENON',   type: 'DJ',      vendor: 'Denon',      name: 'Prime' },
  // --- Arturia ---
  { profile: 'KEYBOARD', type: 'KEYBOARD', vendor: 'Arturia',  name: 'KeyLab' },
  { profile: 'KEYBOARD', type: 'KEYBOARD', vendor: 'Arturia',  name: 'Minilab' },
  // --- M-Audio ---
  { profile: 'KEYBOARD', type: 'KEYBOARD', vendor: 'M-Audio',  name: 'Oxygen' },
];

/** Löst ein MIDI-Gerät (input/output) zu einem Profil auf (falls bekannt). */
export function resolveMidiProfile(name: string, manufacturer?: string): MidiDeviceProfile | null {
  const normName = (name || '').toLowerCase();
  const normMan = (manufacturer || '').toLowerCase();
  for (const entry of MIDI_DEVICE_REGISTRY) {
    const eName = entry.name.toLowerCase();
    const eVendor = entry.vendor.toLowerCase();
    if (normName.includes(eName) || (normMan.includes(eVendor) && normName.includes(eName))) {
      return entry;
    }
    // Vendor allein reicht nicht als hartes Matching; Namen müssen enthalten sein.
  }
  return null;
}

/** Gruppiert die Settings nach Typ für die Skin-Engine. */
export const MIDI_TYPE_LABEL: Record<MidiDeviceType, string> = {
  GRID: 'Grid / Clip-Launcher',
  DJ: 'DJ-Controller',
  MPC: 'Finger-Drumming & Pads',
  KEYBOARD: 'Keyboard-Controller',
  MIXER: 'DAW/Mixer-Controller',
  PAD: 'Pad-Controller',
};
