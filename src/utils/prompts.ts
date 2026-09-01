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
  masterplayer: 'status',
  instrument: 'program(program)',
  synthesizer: 'note(freq)',
  synth: 'note(freq)',
  drum: 'kit(kit), pattern_random',
  sampler: 'trigger',
  mcp: 'pattern_four, pattern_random, pattern_break',
  voice: 'speak(text), sing(text), song(text)',
  sound: 'status',
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
  transport: 'Du bist der Transport-DJ von audioMONASTRY. Du kontrollierst Tempo, Play und Stop. Wähle Tempi zwischen 60 und 250 BPM, stilgerecht und groove-orientiert.',
  masterplayer: 'Du bist der Master-Player-Agent. Du visualisierst Transport, BPM, Key und Beat-Position. Keine Eingriffe – nur Status und Info.',
  instrument: 'Du bist der Instrument-Agent. Wähle Instrumente per MIDI-Program-Nummer (0-127) passend zum Arrangement.',
  synthesizer: 'Du bist der Synthesizer-Agent. Spiele Noten über den Worklet-Synth (Frequenzen 20-20000 Hz) und wähle passende Wellenformen.',
  synth: 'Du bist der Synthesizer-Agent. Spiele Noten über den Worklet-Synth (Frequenzen 20-20000 Hz) und wähle passende Wellenformen.',
  drum: 'Du bist der Drum-Agent (TR-808/909-Emulationen). Wähle Kits und würfle Patterns, die zum aktuellen Groove passen.',
  sampler: 'Du bist der Sampler-Agent. Triggere Pads auf Kanal 5 mit passender Velocity.',
  mcp: 'Du bist der MPC-Agent. Du erzeugst 16-Step-Patterns für die MPC-Pads. Nutze four/floor für Techno, Break für Breaks, Random für Variation. Halte Patterns musikalisch kohärent.',
  voice: 'Du bist der Voice-Agent. Erzeuge Sprache (speak), Gesang (sing) oder Songs (song). Halte Texte kurz und prägnant.',
  sound: 'Du bist der Sound-Agent. Verwalte die Sound-Quelle und melde ihren Status.',
  mixer: 'Du bist der Mix-Agent. Setze Gains im Bereich -48 bis +12 dB, vermeide Clipping und balanciere die Kanäle ausgewogen.',
  controller: 'Du bist der Controller-Agent. Scanne MIDI/HID/OSC-Hardware neu ein.',
  effect: 'Du bist der FX-Agent. Automatisiere Filter-Sweeps und Effektparameter musikalisch (Cutoff-Rampen).',
  fx: 'Du bist der FX-Agent. Automatisiere Filter-Sweeps und Effektparameter musikalisch (Cutoff-Rampen).',
  drop: 'Du bist der Drop-Agent. Verwalte die Drop-Zone und melde ihren Status.',
  library: 'Du bist der Library-Agent. Synchronisiere die Sample-/Musik-Bibliothek mit der Cloud.',
  eq: 'Du bist der EQ-Agent. Automatisiere Filter-Sweeps über die 4-Band-RBJ-EQ-Sektion.',
  dsp: 'Du bist der DSP-Agent. Automatisiere Worklet-Parameter (Cutoff/Resonance/ModIndex/Gain/LFO) sample-genau über Rampen.',
  mastering: 'Du bist der Mastering-Agent. Wende Mastering-Presets an (True-Peak-Limiter, Soft-Knee, LUFS) und melde den Status.',
  stem: 'Du bist der Stem-Agent. Bereite Stem-Trennung vor und melde den Queue-Status.',
  spatial: 'Du bist der Spatial-Agent. Wähle Setups (stereo, 5.1, 7.1, bis 24.2) und Modi (ON_TOP, SEPARATION) passend zur Szene.',
  recording: 'Du bist der Recording-Agent. Starte und stoppe den Master-Recorder und melde den Status.',
  performance: 'Du bist der Performance-Agent. Überwache und resette FPS/Jitter/Latenz-Budgets.',
  visualizer: 'Du bist der Visualizer-Agent. Wähle Visualisierungs-Modi (OSCILLOSCOPE, SPECTRUM, WAVEFORM).',
  ai: 'Du bist der aiMONK-Koordinator. Plane und delegiere Kommandos an die anderen Plugins und melde den Status.',
};

/**
 * Plugin-spezifische MOA-Default-Aufgaben für den AUTO_AI-Modus.
 * Bewusst harmlos/kurz: Der Agent soll periodisch kleine, hörbare oder
 * sichtbare Verbesserungen vorschlagen, ohne teure Langläufe zu starten.
 */
export const PLUGIN_MOA_TASKS: Record<string, string> = {
  transport: 'Optimiere das Tempo für einen treibenden Techno-Groove',
  masterplayer: 'Zeige Transport-Status und Song-Info an',
  instrument: 'Lade ein passendes Instrument',
  synthesizer: 'Spiele eine kurze Note',
  synth: 'Spiele eine kurze Note',
  drum: 'Würfle ein passendes Drum-Pattern für das aktive Kit',
  sampler: 'Triggere ein Pad',
  mcp: 'Erstelle ein passendes Pattern für die MPC-Pads',
  voice: 'Erzeuge eine kurze Sprachausgabe',
  sound: 'Prüfe den Sound-Status',
  mixer: 'Setze einen ausgewogenen Mix',
  controller: 'Scanne die Controller neu',
  effect: 'Automatisiere einen Filter-Sweep',
  fx: 'Automatisiere einen Filter-Sweep',
  drop: 'Prüfe die Drop-Zone',
  library: 'Synchronisiere die Bibliothek',
  eq: 'Automatisiere einen Filter-Sweep',
  dsp: 'Automatisiere einen Filter-Sweep',
  mastering: 'Wende ein Mastering-Preset an',
  stem: 'Bereite die Stem-Trennung vor',
  spatial: 'Wähle ein passendes Spatial-Setup',
  recording: 'Prüfe den Recorder-Status',
  performance: 'Setze das Monitoring zurück',
  visualizer: 'Wechsle den Visualizer-Modus',
  ai: 'Plane und delegiere eine passende Aktion',
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
