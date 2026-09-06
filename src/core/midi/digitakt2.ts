/**
 * audioMONASTRY · Digitakt 2 (Elektron) – MIDI-Map + Pattern-Feed
 * ==============================================================
 * Produktionsreife Steuer-Daten für Digitakt/Digitakt 2 (Track-Mode):
 *   - CC-Map (Parameter je Track)
 *   - TRIG-Taste = CC 36-51 je Track (Pattern-Live-Recording)
 *   - Transport-Sync über MIDI Clock (F8) + Start/Continue/Stop
 *   - Pattern-Feed: deterministische MIDI-Bytes für Step-Trig (Note 60)
 * Referenz: Elektron Digitakt MIDI-Spezifikation (Track 1-8, CC 0-127).
 */

export const DIGITAKT_TRACKS = 8;

/** Wichtige CCs im Track-Mode (Digitakt). */
export const DIGITAKT_CC: Record<string, number> = {
  level: 7,
  pan: 10,
  filterFreq: 74,
  filterRes: 71,
  filterType: 73,
  delaySend: 91,
  reverbSend: 93,
  page: 75,
  trig: 36, // TRIG-Tasten Track 1-8 = CC 36-43 (Seite 1) bzw. 44-51 (Seite 2)
};

export function ccForTrack(baseCc: number, track: number, page2 = false): number {
  const t = Math.max(0, Math.min(DIGITAKT_TRACKS - 1, track));
  if (baseCc === DIGITAKT_CC.trig) return 36 + t + (page2 ? 8 : 0);
  return baseCc;
}

export interface DigitaktPatternStep {
  track: number;
  step: number;      // 0..15
  on: boolean;
  note?: number;     // 0..127 (Digitakt Tracks spielen Samples; Note 60 = Trigger)
  velocity?: number; // 1..127
}

/**
 * Erzeugt eine MIDI-Note-Nachricht (3 Bytes) für einen Pattern-Step.
 * Digitakt im TRIG-Mode spricht auf Note an (MIDI-Kanal des Tracks 1-8).
 */
export function patternStepMessage(step: DigitaktPatternStep): number[] {
  const track = Math.max(0, Math.min(DIGITAKT_TRACKS - 1, step.track));
  const channel = track; // Track 1-8 → Kanal 0-7 (0-basiert)
  const status = step.on ? 0x90 : 0x80; // Note On / Note Off
  const note = step.note ?? 60;
  const velocity = step.on ? Math.max(1, Math.min(127, step.velocity ?? 100)) : 0;
  return [status | channel, note, velocity];
}

/** MIDI-Clock-Tick (F8) – 24 Ticks pro Viertel. */
export function midiClockTick(): number[] { return [0xf8]; }

export function midiClockStart(): number[] { return [0xfa]; }
export function midiClockContinue(): number[] { return [0xfb]; }
export function midiClockStop(): number[] { return [0xfc]; }

/** Ein 16-Step-Pattern (16 Sequencer-Steps) in MIDI-Bytes umwandeln. */
export function patternToMidi(events: DigitaktPatternStep[]): number[][] {
  return events.filter((e) => e.track >= 0 && e.track < DIGITAKT_TRACKS && e.step >= 0 && e.step < 16)
    .sort((a, b) => a.track - b.track || a.step - b.step)
    .map(patternStepMessage);
}

/** CC-Nachricht für einen Parameter auf einem Track. */
export function ccMessage(track: number, cc: number, value: number): number[] {
  const t = Math.max(0, Math.min(DIGITAKT_TRACKS - 1, track));
  return [0xb0 | t, cc & 0x7f, Math.max(0, Math.min(127, value))];
}
