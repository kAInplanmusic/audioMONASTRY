/**
 * audioMONASTRY · instrumentMONK – Zentrale Control-Brücke
 * =========================================================
 * Einheitlicher Kontrollpfad für alle Instrumenten-Eingaben:
 *
 *   UI (Canvas/Keyboard/Pads) + MIDI/HID/OSC → ControlMessage → IInstrumentBackend
 *
 * Damit laufen UI-Noten über dieselbe Control-Abstraktion wie physische
 * Controller – keine UI-Komponente spricht die Audio-Engine direkt an.
 */
import type { ControlMessage } from '../interfaces';
import { instrumentBackend } from './InstrumentBackend';

/**
 * Reicht ein `ControlMessage` an das `IInstrumentBackend` weiter.
 * 7-Bit-MIDI-Konvention: `value` 0..127 → Velocity 0..1.
 */
export function dispatchInstrumentControl(msg: ControlMessage): void {
  switch (msg.kind) {
    case 'noteOn':
      instrumentBackend.noteOn(msg.idNum, Math.max(0, Math.min(1, msg.value / 127)));
      break;
    case 'noteOff':
      instrumentBackend.noteOff();
      break;
    case 'program':
      void instrumentBackend.handleProgramChange(msg.idNum, msg.channel);
      break;
    default:
      // CC/Pitch/Transport etc. betreffen nicht den Instrumenten-Backend.
      break;
  }
}

/** Velocity 0..1 als 7-Bit-MIDI-Wert (0..127) kodieren. */
export function velocityToMidi(velocity01: number): number {
  return Math.max(0, Math.min(127, Math.round(velocity01 * 127)));
}
