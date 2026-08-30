// src/utils/midi.ts – MIDI-Kodierung/Dekodierung (CC, NRPN, SysEx, Notes)
// =============================================================================
// Reine, plattformfreie Helfer für Web MIDI, node-midi & Sidecars.
// Alle Funktionen sind NaN-sicher und clamps auf den 7/14-Bit-Bereich.
// =============================================================================

export const MIDI_STATUS = {
  noteOff: 0x80,
  noteOn: 0x90,
  polyAftertouch: 0xa0,
  controlChange: 0xb0,
  programChange: 0xc0,
  channelAftertouch: 0xd0,
  pitchBend: 0xe0,
  sysex: 0xf0,
  sysexEnd: 0xf7,
} as const;

export type MidiMessageKind =
  | 'noteOff' | 'noteOn' | 'polyAftertouch' | 'controlChange'
  | 'programChange' | 'channelAftertouch' | 'pitchBend' | 'sysex' | 'unknown';

export const clamp7 = (v: number): number => Math.max(0, Math.min(127, Math.round(v)));
export const clamp14 = (v: number): number => Math.max(0, Math.min(16383, Math.round(v)));

/** Kanal aus einem Status-Byte (0–15). */
export function channelOf(status: number): number {
  return status & 0x0f;
}

/** Zerlegt ein Status-Byte in Art + Kanal. */
export function parseStatus(status: number): { kind: MidiMessageKind; channel: number } {
  const hi = status & 0xf0;
  const channel = channelOf(status);
  switch (hi) {
    case 0x80: return { kind: 'noteOff', channel };
    case 0x90: return { kind: 'noteOn', channel };
    case 0xa0: return { kind: 'polyAftertouch', channel };
    case 0xb0: return { kind: 'controlChange', channel };
    case 0xc0: return { kind: 'programChange', channel };
    case 0xd0: return { kind: 'channelAftertouch', channel };
    case 0xe0: return { kind: 'pitchBend', channel };
    case 0xf0: return { kind: 'sysex', channel: 0 };
    default: return { kind: 'unknown', channel };
  }
}

/** Control Change (Kanal 0–15). */
export function cc(channel: number, controller: number, value: number): number[] {
  return [MIDI_STATUS.controlChange | (channel & 0x0f), clamp7(controller), clamp7(value)];
}

/** Note On (velocity 0 = Note Off gemäß MIDI-Konvention). */
export function noteOn(channel: number, note: number, velocity: number): number[] {
  return [MIDI_STATUS.noteOn | (channel & 0x0f), clamp7(note), clamp7(velocity)];
}

export function noteOff(channel: number, note: number, velocity = 0): number[] {
  return [MIDI_STATUS.noteOff | (channel & 0x0f), clamp7(note), clamp7(velocity)];
}

/** Pitch Bend (14-Bit-Wert, Mitte = 8192). */
export function pitchBend(channel: number, value14: number): number[] {
  const v = clamp14(value14);
  return [MIDI_STATUS.pitchBend | (channel & 0x0f), v & 0x7f, (v >> 7) & 0x7f];
}

export const split14 = (value: number): { msb: number; lsb: number } => {
  const v = clamp14(value);
  return { msb: (v >> 7) & 0x7f, lsb: v & 0x7f };
};

export const join14 = (msb: number, lsb: number): number => ((clamp7(msb) << 7) | clamp7(lsb)) & 0x3fff;

/** NRPN senden (14-Bit-Parameter + 14-Bit-Wert, inkl. RPN-Null). */
export function nrpn(channel: number, nrpnNumber: number, value14: number): number[] {
  const ch = channel & 0x0f;
  const n = split14(nrpnNumber);
  const v = split14(value14);
  return [
    MIDI_STATUS.controlChange | ch, 99, n.msb,
    MIDI_STATUS.controlChange | ch, 98, n.lsb,
    MIDI_STATUS.controlChange | ch, 6, v.msb,
    MIDI_STATUS.controlChange | ch, 38, v.lsb,
    MIDI_STATUS.controlChange | ch, 101, 0x7f,
    MIDI_STATUS.controlChange | ch, 100, 0x7f,
  ];
}

/** SysEx-Nachricht bauen (F0 … F7). */
export function sysex(payload: number[]): number[] {
  return [MIDI_STATUS.sysex, ...payload.map((b) => b & 0x7f), MIDI_STATUS.sysexEnd];
}

/** Prüft, ob ein Byte-Array eine vollständige SysEx-Nachricht ist. */
export function isSysex(data: ArrayLike<number>): boolean {
  return data.length >= 2 && (data[0] & 0xf0) === 0xf0 && data[data.length - 1] === 0xf7;
}

/** Extrahiert den Payload einer SysEx-Nachricht (ohne F0/F7). */
export function parseSysex(data: ArrayLike<number>): number[] {
  if (!isSysex(data)) return [];
  const out: number[] = [];
  for (let i = 1; i < data.length - 1; i++) out.push(data[i] & 0x7f);
  return out;
}

/**
 * Zustandsbehafteter NRPN-Parser: akkumuliert CC 99/98 (Nummer) und
 * CC 6/38 (Wert) und liefert bei vollständigem Wert { nrpn, value }.
 */
export class NrpnParser {
  private nrpnMsb = 0x7f;
  private nrpnLsb = 0x7f;
  private dataMsb = 0;
  private dataLsb = 0;
  private hasMsb = false;
  private hasLsb = false;

  /** Füttert einen einzelnen CC (controller, value). Liefert Wert oder null. */
  push(controller: number, value: number): { nrpn: number; value: number } | null {
    switch (controller) {
      case 99: this.nrpnMsb = clamp7(value); return null;
      case 98: this.nrpnLsb = clamp7(value); return null;
      case 6: this.dataMsb = clamp7(value); this.hasMsb = true; break;
      case 38: this.dataLsb = clamp7(value); this.hasLsb = true; break;
      case 101: case 100: return null; // RPN-Null
      default: return null;
    }
    if (this.hasMsb && this.hasLsb) {
      const nrpn = join14(this.nrpnMsb, this.nrpnLsb);
      const value14 = join14(this.dataMsb, this.dataLsb);
      this.hasMsb = false;
      this.hasLsb = false;
      return { nrpn, value: value14 };
    }
    return null;
  }

  reset(): void {
    this.nrpnMsb = 0x7f;
    this.nrpnLsb = 0x7f;
    this.dataMsb = 0;
    this.dataLsb = 0;
    this.hasMsb = false;
    this.hasLsb = false;
  }
}
