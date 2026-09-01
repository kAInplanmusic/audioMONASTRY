/**
 * audioMONASTRY · MIDI-Out-Helfer (P1-6)
 * ========================================
 * Encode-Helfer für LEDs/Motorfader-Feedback an Controller.
 */

export function midiNoteOn(channel: number, note: number, velocity: number): number[] {
  const ch = Math.max(0, Math.min(15, Math.round(channel - 1)));
  return [0x90 | ch, Math.max(0, Math.min(127, Math.round(note))), Math.max(0, Math.min(127, Math.round(velocity)))];
}

export function midiLed(channel: number, note: number, on: boolean, color = 1): number[] {
  return midiNoteOn(channel, note, on ? Math.max(1, Math.min(127, color)) : 0);
}

/** Motorfader-Position als Pitch-Bend (14-Bit) senden. */
export function midiMotorFader(channel: number, position01: number): number[] {
  const v = Math.max(0, Math.min(16383, Math.round(position01 * 16383)));
  const ch = Math.max(0, Math.min(15, Math.round(channel - 1)));
  return [0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f];
}

/** CC für Endlos-Encoder mit LED-Ring (0..127). */
export function midiEncoderRing(channel: number, controller: number, value: number): number[] {
  const ch = Math.max(0, Math.min(15, Math.round(channel - 1)));
  return [0xb0 | ch, Math.max(0, Math.min(127, Math.round(controller))), Math.max(0, Math.min(127, Math.round(value)))];
}
