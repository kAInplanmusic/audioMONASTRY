/**
 * audioMONASTRY · 8.2.2 – Hardware-Simulator (Entwicklung ohne Geräte)
 * ====================================================================
 * Simuliert MIDI/HID-Controller mit identischem ControlMessage-Protokoll.
 * Ermöglicht Hardware-Entwicklung und Tests ohne physische Geräte.
 */
import type { ControlMessage } from '../interfaces';

export class HardwareSimulator {
  private onControl: (msg: ControlMessage) => void = () => {};
  private timers: ReturnType<typeof setInterval>[] = [];

  onControlMessage(cb: (msg: ControlMessage) => void): void {
    this.onControl = cb;
  }

  /** Sendet ein einzelnes ControlMessage (z. B. Fader/Note). */
  emit(msg: ControlMessage): void {
    this.onControl(msg);
  }

  /** Simuliert einen Fader-Sweep (CC 0..127 über `durationMs`). */
  sweep(cc: number, channel = 1, durationMs = 2000, steps = 64): void {
    let step = 0;
    const timer = setInterval(() => {
      if (step > steps) {
        clearInterval(timer);
        return;
      }
      const value = Math.round((step / steps) * 127);
      this.onControl({ kind: 'cc', idNum: cc, value, channel });
      step++;
    }, durationMs / steps);
    this.timers.push(timer);
  }

  /** Simuliert einen Program-Change. */
  programChange(program: number, channel = 1): void {
    this.onControl({ kind: 'program', idNum: program, value: program, channel });
  }

  /** Simuliert Note-On/Off-Paare im Raster. */
  notePattern(notes: number[], intervalMs = 250, channel = 1): void {
    let i = 0;
    const timer = setInterval(() => {
      if (i >= notes.length) {
        clearInterval(timer);
        return;
      }
      this.onControl({ kind: 'noteOn', idNum: notes[i], value: 100, channel });
      this.onControl({ kind: 'noteOff', idNum: notes[i], value: 0, channel });
      i++;
    }, intervalMs);
    this.timers.push(timer);
  }

  stop(): void {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
  }
}

export const hardwareSimulator = new HardwareSimulator();
