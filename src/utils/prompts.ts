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
  instrument: 'program(program)',
  synthesizer: 'note(freq)',
  synth: 'note(freq)',
  drum: 'kit(kit), pattern_random',
  sampler: 'trigger',
  mcp: 'pattern_four, pattern_random, pattern_break',
  voice: 'speak(text), sing(text), song(text)',
  sound: 'status',
  song: 'generate(prompt), status',
  mixer: 'gain(db)',
  controller: 'rescan',
  effect: 'automate',
  fx: 'automate',
  drop: 'status',
  library: 'sync',
  eq: 'automate',
  dsp: 'automate',
  mastering: 'preset(preset), status',
  stem: 'separate, status',
  spatial: 'setup(id), mode(mode)',
  recording: 'start, stop, status',
  performance: 'reset, status',
  visualizer: 'mode(mode)',
  ai: 'status',
};

/**
 * Plugin-spezifische KI-System-Prompts. Der MoaAgent wählt für jeden Schritt
 * den Prompt des Ziel-Plugins → jedes Plugin wird von einer "eigenen" KI-Rolle
 * gesteuert (Fachwissen, Parameter-Grenzen, Erfolgskriterien).
 */
export const PLUGIN_MOA_SYSTEM_PROMPTS: Record<string, string> = {
  transport: 'Du bist der Transport-DJ. Kontrolliere Tempo (60-250 BPM), Play und Stop.',
  instrument: 'Du bist der Instrument-Agent. Wähle MIDI-Programme (0-127).',
  synthesizer: 'Du bist der Synth-Agent. Spiele Noten (20-20000 Hz) über den Worklet-Synth.',
  synth: 'Du bist der Synth-Agent. Spiele Noten (20-20000 Hz) über den Worklet-Synth.',
  drum: 'Du bist der Drum-Agent (TR-808/909). Wähle Kits und Patterns.',
  sampler: 'Du bist der Sampler-Agent. Triggere Pads auf Kanal 5.',
  mcp: 'Du bist der MPC-Agent. Erzeuge 16-Step-Patterns (four/break/random).',
  voice: 'Du bist der Voice-Agent. Nutze speak/sing/song mit kurzen Texten.',
  sound: 'Du bist der Sound-Agent. Verwalte die Sound-Quelle und melde den Status.',
  song: 'Du bist der Song-Agent. Generiere komplette Songs/Tracks aus Text-Prompts über generate(prompt).',
  mixer: 'Du bist der Mix-Agent. Setze Gains (-48 bis +12 dB), vermeide Clipping.',
  controller: 'Du bist der Controller-Agent. Scanne MIDI/HID/OSC-Hardware neu.',
  effect: 'Du bist der FX-Agent. Automatisiere Filter-Sweeps musikalisch.',
  fx: 'Du bist der FX-Agent. Automatisiere Filter-Sweeps musikalisch.',
  drop: 'Du bist der Drop-Agent. Verwalte die Drop-Zone und melde den Status.',
  library: 'Du bist der Library-Agent. Synchronisiere die Bibliothek mit der Cloud.',
  eq: 'Du bist der EQ-Agent. Automatisiere Filter-Sweeps über die EQ-Sektion.',
  dsp: 'Du bist der DSP-Agent. Automatisiere Worklet-Parameter sample-genau.',
  mastering: 'Du bist der Mastering-Agent. Wende Presets an und melde den Status.',
  stem: 'Du bist der Stem-Agent. Bereite die Stem-Trennung vor, melde den Queue-Status.',
  spatial: 'Du bist der Spatial-Agent. Wähle Setups (bis 24.2) und Modi (ON_TOP/SEPARATION).',
  recording: 'Du bist der Recording-Agent. Starte/stoppe den Recorder, melde den Status.',
  performance: 'Du bist der Performance-Agent. Überwache FPS/Jitter/Latenz, setze zurück.',
  visualizer: 'Du bist der Visualizer-Agent. Wähle Modi (OSCILLOSCOPE/SPECTRUM/WAVEFORM).',
  ai: 'Du bist der aiMONK-Koordinator. Plane und delegiere Kommandos, melde den Status.',
};

export const PLUGIN_MOA_TASKS: Record<string, string> = {
  transport: 'Optimiere das Tempo',
  instrument: 'Lade ein passendes Instrument',
  synthesizer: 'Spiele eine kurze Note',
  synth: 'Spiele eine kurze Note',
  drum: 'Würfle ein Drum-Pattern',
  sampler: 'Triggere ein Pad',
  mcp: 'Erstelle ein MPC-Pattern',
  voice: 'Erzeuge eine Sprachausgabe',
  sound: 'Prüfe den Sound-Status',
  song: 'Generiere einen Song/Track',
  mixer: 'Setze einen ausgewogenen Mix',
  controller: 'Scanne Controller neu',
  effect: 'Automatisiere einen Filter-Sweep',
  fx: 'Automatisiere einen Filter-Sweep',
  drop: 'Prüfe die Drop-Zone',
  library: 'Synchronisiere die Bibliothek',
  eq: 'Automatisiere einen Filter-Sweep',
  dsp: 'Automatisiere einen Filter-Sweep',
  mastering: 'Wende ein Mastering-Preset an',
  stem: 'Bereite Stem-Trennung vor',
  spatial: 'Wähle ein Spatial-Setup',
  recording: 'Prüfe den Recorder-Status',
  performance: 'Setze Monitoring zurück',
  visualizer: 'Wechsle den Visualizer-Modus',
  ai: 'Plane eine passende Aktion',
};

/** Liefert die MOA-Default-Aufgabe für ein Plugin (Fallback: generisch). */
export function moaTaskForPlugin(pluginId: string): string {
  return PLUGIN_MOA_TASKS[pluginId] ?? 'Optimiere dieses Modul';
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
    ?? 'Du bist ein audioMONASTRY-Produktions-Agent. Wähle passende Kommandos aus dem Katalog.';
}
