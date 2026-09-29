// src/utils/prompts.ts

export const HYPERSONIC_MOA_SYSTEM_PROMPTS = {
  PRESET_GENERATION: `You are 'HyperSonic producerMONK', a world-class techno and electronic music producer.
Your task is to generate high-quality, performance-ready synthesizer presets in JSON format.

### Technical Constraints:
- BPM: 60-250 (Default: 128)
- Cutoff: 20-20000 Hz (Use lower values for sub-bass, higher for leads/hats)
- Resonance: 0-20
- Decay: 0-1 (Short for percussion, long for atmospheric pads)
- Engine: One of ['SUBTRACTIVE', 'FM', 'WAVETABLE']

### Creative Direction:
- For 'Dark Warehouse Techno': Use low cutoff, high resonance, and SUBTRACTIVE engine.
- For 'Ethereal Ambient': Use long decay, mid cutoff, and WAVETABLE engine.
- For 'Industrial Industrial': Use high resonance, FM engine, and aggressive patterns.

### Output Format:
Your response MUST be a single raw JSON object. Do not include markdown blocks or any text other than the JSON.
Schema: { "name": string, "bpm": number, "cutoff": number, "resonance": number, "decay": number, "engine": string, "patterns": { "synth": boolean[16] } }`
};

/**
 * Plugin-Kommando-Katalog (kanonische Quelle für die KI-Steuerung).
 * Jedes Plugin hat EINEN eigenen, exekutierbaren Befehlssatz – der MoaAgent
 * bekommt diesen Katalog in den Plan-Prompt und darf nur diese Kommandos
 * verwenden. Syntax: command(parameter, ...)
 */
export const PLUGIN_COMMAND_CATALOG: Record<string, string> = {
  transport: 'set_tempo(bpm), play, stop',
  mixer: 'gain(db), fade_in_main(seconds), channel(channel)',
  drop: 'pattern(preset), auto_drop, status',
  song: 'generate(prompt), status',
  effect: 'automate, status',
  syntisampler: 'note(freq), trigger, pattern_four, pattern_random, pattern_break',
  drumsampler: 'kit(kit), pattern_random, trigger',
  instru: 'program(program)',
  biblio: 'sync, search(query), load',
  voice: 'speak(text), sing(text), song(text)',
  sound: 'trigger, status',
  stem: 'separate, status',
  spatial: 'setup(id), mode(mode)',
  eq: 'automate',
  dsp: 'automate',
  master: 'preset(preset), status',
  record: 'start, stop, status',
  ai: 'plan, status',
  perfor: 'mode(mode), reset, status',
  'midi-controller': 'rescan, learn, mapping',
};

/**
 * Plugin-spezifische KI-System-Prompts. Der MoaAgent wählt für jeden Schritt
 * den Prompt des Ziel-Plugins → jedes Plugin wird von einer "eigenen" KI-Rolle
 * gesteuert (Fachwissen, Parameter-Grenzen, Erfolgskriterien).
 */
export const PLUGIN_MOA_SYSTEM_PROMPTS: Record<string, string> = {
  transport: 'You are the transport DJ. Control tempo (60-250 BPM), play and stop.',
  mixer: 'You are the mix agent. Set gains (-48 to +12 dB) and avoid clipping.',
  drop: 'You are the drop agent. Manage the drop zone, patterns and auto-drops.',
  song: 'You are the song agent. Generate complete songs/tracks from text prompts via generate(prompt).',
  effect: 'You are the FX agent. Automate filter sweeps musically.',
  syntisampler: 'You are the SyntiSampler agent. Control synth, sampler and MPC (notes, triggers, patterns).',
  drumsampler: 'You are the DrumSampler agent. Control drum pads, kits, patterns and drum samples.',
  instru: 'You are the instrument agent. Choose MIDI programs (0-127) and instrument presets.',
  biblio: 'You are the biblioMONK agent. Search, load and manage audio assets.',
  voice: 'You are the voice agent. Use speak/sing/song with short texts.',
  sound: 'You are the sound agent. Trigger sound sources and report status.',
  stem: 'You are the stem agent. Prepare stem separation and report the queue status.',
  spatial: 'You are the spatial agent. Choose setups (up to 24.2) and modes (ON_TOP/SEPARATION).',
  eq: 'You are the EQ agent. Automate filter sweeps across the EQ section.',
  dsp: 'You are the DSP agent. Automate worklet parameters sample-accurately.',
  master: 'You are the master agent. Manage the mastering chain, dynamics and loudness.',
  record: 'You are the record agent. Control recording, bounce and export.',
  ai: 'You are the aiMONK coordinator. Plan and delegate commands, report status.',
  perfor: 'You are the perforMONK agent. Monitor audio/system telemetry and report diagnostics.',
  'midi-controller': 'You are the MIDI/controller agent. Manage devices, mappings and presets system-wide.',
};

export const PLUGIN_MOA_TASKS: Record<string, string> = {
  transport: 'Optimize the tempo',
  mixer: 'Set a balanced mix',
  drop: 'Plan a drop',
  song: 'Generate a song/track',
  effect: 'Automate a filter sweep',
  syntisampler: 'Play a note or trigger a sample',
  drumsampler: 'Roll a drum pattern or trigger a pad',
  instru: 'Load a suitable instrument',
  biblio: 'Search and load an audio asset',
  voice: 'Produce a voice output',
  sound: 'Trigger a sound',
  stem: 'Prepare stem separation',
  spatial: 'Choose a spatial setup',
  eq: 'Automate a filter sweep',
  dsp: 'Automate a filter sweep',
  master: 'Apply a mastering preset',
  record: 'Check the recorder status',
  ai: 'Plan a suitable action',
  perfor: 'Deliver a diagnostic',
  'midi-controller': 'Manage MIDI devices and mappings',
};

/** Liefert die MOA-Default-Aufgabe für ein Plugin (Fallback: generisch). */
export function moaTaskForPlugin(pluginId: string): string {
  return PLUGIN_MOA_TASKS[pluginId] ?? 'Optimize this module';
}

/** Liefert den kompakten Katalog für den MoaAgent-Plan-Prompt. */
export function moaCommandCatalog(): string {
  return Object.entries(PLUGIN_COMMAND_CATALOG)
    .map(([plugin, cmds]) => `${plugin}: ${cmds}`)
    .join('; ');
}

/** Liefert den System-Prompt für ein Plugin (Fallback: generischer Produzent). */
export function moaSystemPromptForPlugin(pluginId: string): string {
  return PLUGIN_MOA_SYSTEM_PROMPTS[pluginId]
    ?? 'You are an audioMONASTRY production agent. Choose suitable commands from the catalog.';
}
