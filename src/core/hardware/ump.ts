/**
 * audioMONASTRY · MIDI 2.0 / UMP-Codec (plattformneutral)
 * ========================================================
 * Universal MIDI Packet (UMP) nach MIDI-2.0-Spezifikation:
 * 32-Bit-Wörter, 1–4 Wörter pro Paket, Message Types 0x0–0x5.
 *
 * Fokus (bewusst begrenzt, siehe Audit G11):
 * - MT2: MIDI-1.0-Channel-Voice in UMP (bidirektional zu MIDI-1.0-Bytes)
 * - MT4: MIDI-2.0-Channel-Voice (Note On/Off, CC/Assignable Controller,
 *        Pitch Bend, Channel Pressure, Program Change) mit 16/32-Bit-Werten
 * - MT0/MT1/MT3/MT5: strukturelles Parsing (kein vollständiges System-/
 *        SysEx-Streaming — erst bei Hardware-Bedarf)
 *
 * Keine Browser-/Node-Abhängigkeiten. Vollständig unit-testbar.
 */

export type UmpMessageType = 0x0 | 0x1 | 0x2 | 0x3 | 0x4 | 0x5;

export interface UmpPacket {
  messageType: UmpMessageType;
  group: number; // 0..15
  words: number[]; // 1..4 × 32-Bit
}

export interface UmpMidi1ChannelVoice {
  kind: 'midi1ChannelVoice';
  group: number;
  /** Originales Status-Byte (0x80..0xEF). */
  status: number;
  data1: number;
  data2: number;
}

export interface UmpMidi2NoteOn {
  kind: 'midi2NoteOn';
  group: number;
  channel: number; // 1..16
  note: number;
  velocity16: number; // 0..65535
  attributeType: number;
  attribute: number; // 16-Bit
}

export interface UmpMidi2NoteOff {
  kind: 'midi2NoteOff';
  group: number;
  channel: number;
  note: number;
  velocity16: number;
  attributeType: number;
  attribute: number;
}

export interface UmpMidi2Controller {
  kind: 'midi2Controller';
  group: number;
  channel: number;
  /** 0x0 = Registered (RPN), 0x1 = Assignable (NRPN), 0x2/0x3 = relativ. */
  status: 0x0 | 0x1 | 0x2 | 0x3;
  bank: number;
  index: number;
  value32: number;
}

export interface UmpMidi2PitchBend {
  kind: 'midi2PitchBend';
  group: number;
  channel: number;
  /** 32-Bit, Mitte = 0x80000000. */
  value32: number;
}

export interface UmpMidi2ChannelPressure {
  kind: 'midi2ChannelPressure';
  group: number;
  channel: number;
  value32: number;
}

export interface UmpMidi2ProgramChange {
  kind: 'midi2ProgramChange';
  group: number;
  channel: number;
  program: number;
  /** 7-Bit-Bank-Feld (MSB) aus Wort 0; Bank-LSB wird ggf. separat übertragen. */
  bank: number;
  bankValid: boolean;
}

export type ParsedUmp =
  | UmpMidi1ChannelVoice
  | UmpMidi2NoteOn
  | UmpMidi2NoteOff
  | UmpMidi2Controller
  | UmpMidi2PitchBend
  | UmpMidi2ChannelPressure
  | UmpMidi2ProgramChange;

// ---------------------------------------------------------------------------
// Wort-Arithmetik
// ---------------------------------------------------------------------------

const MT_WORDS: Record<number, number> = {
  0x0: 1, 0x1: 1, 0x2: 1, 0x3: 2, 0x4: 2, 0x5: 4,
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));

/** Liefert die Wort-Anzahl eines UMP-Pakets anhand des Message Types. */
export function umpWordCount(messageType: number): number {
  return MT_WORDS[messageType & 0xf] ?? 0;
}

/** Parst ein Array aus 32-Bit-Wörtern in ein UMP-Paket (strukturell). */
export function parseUmpPacket(words: number[]): UmpPacket {
  if (words.length === 0) throw new Error('UMP: leeres Paket');
  const w0 = words[0] >>> 0;
  const messageType = ((w0 >>> 28) & 0xf) as UmpMessageType;
  const group = (w0 >>> 24) & 0xf;
  const expected = umpWordCount(messageType);
  if (expected === 0) throw new Error(`UMP: unbekannter Message Type ${messageType}`);
  if (words.length < expected) throw new Error(`UMP: ${expected} Wörter erwartet, ${words.length} erhalten`);
  return { messageType, group, words: words.slice(0, expected) };
}

/** Interpretiert ein MT2-Paket als MIDI-1.0-Channel-Voice. */
export function parseUmpMidi1ChannelVoice(packet: UmpPacket): UmpMidi1ChannelVoice {
  if (packet.messageType !== 0x2) throw new Error('UMP: kein MT2-Paket');
  const w0 = packet.words[0] >>> 0;
  const status = (w0 >>> 16) & 0xff;
  const data1 = (w0 >>> 8) & 0x7f;
  const data2 = w0 & 0x7f;
  return { kind: 'midi1ChannelVoice', group: packet.group, status, data1, data2 };
}

/** Kodiert ein MIDI-1.0-Status-Byte + Daten als MT2-UMP-Wort. */
export function encodeUmpMidi1ChannelVoice(group: number, status: number, data1: number, data2: number): number {
  const g = clamp(group, 0, 15);
  const st = status & 0xf0;
  if (st < 0x80 || st >= 0xf0) throw new Error(`UMP MT2: ungültiges Status-Byte 0x${status.toString(16)}`);
  return (
    ((0x2 << 28) | (g << 24) | ((status & 0xff) << 16) | ((clamp(data1, 0, 127) & 0x7f) << 8) | (clamp(data2, 0, 127) & 0x7f)) >>> 0
  );
}

/** MT2-Wort → MIDI-1.0-Bytes (3 Byte). */
export function umpMidi1ToBytes(packet: UmpPacket): number[] {
  const m = parseUmpMidi1ChannelVoice(packet);
  return [m.status & 0xff, m.data1, m.data2];
}

// ---------------------------------------------------------------------------
// MT4: MIDI 2.0 Channel Voice
// ---------------------------------------------------------------------------

export function parseUmpMidi2(packet: UmpPacket): ParsedUmp {
  if (packet.messageType !== 0x4) throw new Error('UMP: kein MT4-Paket');
  const w0 = packet.words[0] >>> 0;
  const w1 = packet.words[1] >>> 0;
  const group = packet.group;
  const status = (w0 >>> 20) & 0xf;
  const channel = ((w0 >>> 16) & 0xf) + 1;

  switch (status) {
    case 0x0: case 0x1: case 0x2: case 0x3: {
      const bank = (w0 >>> 8) & 0xff;
      const index = w0 & 0xff;
      return {
        kind: 'midi2Controller', group, channel, status,
        bank, index, value32: w1 >>> 0,
      };
    }
    case 0x5: case 0x6: {
      const note = (w0 >>> 8) & 0xff;
      const attributeType = w0 & 0xff;
      const velocity16 = (w1 >>> 16) & 0xffff;
      const attribute = w1 & 0xffff;
      return status === 0x6
        ? { kind: 'midi2NoteOn', group, channel, note, velocity16, attributeType, attribute }
        : { kind: 'midi2NoteOff', group, channel, note, velocity16, attributeType, attribute };
    }
    case 0xb: {
      return { kind: 'midi2ChannelPressure', group, channel, value32: w1 >>> 0 };
    }
    case 0xc: {
      return { kind: 'midi2PitchBend', group, channel, value32: w1 >>> 0 };
    }
    case 0xd: {
      const option = (w0 >>> 8) & 0xff;
      const program = option & 0x7f;
      const bankValid = (option & 0x80) !== 0;
      const bank = w0 & 0x7f; // 7-Bit-Bank-Feld (MSB) in den Bits 6..0
      return {
        kind: 'midi2ProgramChange', group, channel, program,
        bank: bankValid ? bank : 0, bankValid,
      };
    }
    default:
      throw new Error(`UMP MT4: Status 0x${status.toString(16)} (noch) nicht dekodiert`);
  }
}

function mt4Word0(group: number, status: number, channel: number): number {
  const g = clamp(group, 0, 15);
  const ch = clamp(channel - 1, 0, 15);
  return ((0x4 << 28) | (g << 24) | ((status & 0xf) << 20) | (ch << 16)) >>> 0;
}

export function encodeUmpMidi2NoteOn(group: number, channel: number, note: number, velocity16: number, attributeType = 0, attribute = 0): number[] {
  return [
    mt4Word0(group, 0x6, channel) | (clamp(note, 0, 127) << 8) | clamp(attributeType, 0, 255),
    ((clamp(velocity16, 0, 65535) << 16) | clamp(attribute, 0, 65535)) >>> 0,
  ];
}

export function encodeUmpMidi2NoteOff(group: number, channel: number, note: number, velocity16: number, attributeType = 0, attribute = 0): number[] {
  return [
    mt4Word0(group, 0x5, channel) | (clamp(note, 0, 127) << 8) | clamp(attributeType, 0, 255),
    ((clamp(velocity16, 0, 65535) << 16) | clamp(attribute, 0, 65535)) >>> 0,
  ];
}

export function encodeUmpMidi2Controller(group: number, channel: number, status: 0x0 | 0x1, bank: number, index: number, value32: number): number[] {
  return [
    (mt4Word0(group, status, channel) | (clamp(bank, 0, 255) << 8) | clamp(index, 0, 255)) >>> 0,
    value32 >>> 0,
  ];
}

export function encodeUmpMidi2PitchBend(group: number, channel: number, value32: number): number[] {
  return [mt4Word0(group, 0xc, channel), value32 >>> 0];
}

export function encodeUmpMidi2ChannelPressure(group: number, channel: number, value32: number): number[] {
  return [mt4Word0(group, 0xb, channel), value32 >>> 0];
}

// ---------------------------------------------------------------------------
// MIDI 1.0 ↔ UMP-Helfer
// ---------------------------------------------------------------------------

/** MIDI-1.0-Bytes (Status + Daten) → UMP-Wörter (MT2). */
export function midi1BytesToUmp(bytes: ArrayLike<number>, group = 0): number[] {
  if (bytes.length === 0) return [];
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const status = bytes[i] & 0xff;
    if (status >= 0x80 && status < 0xf0) {
      const kind = status & 0xf0;
      const len = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      const data1 = bytes[i + 1] ?? 0;
      const data2 = len === 2 ? (bytes[i + 2] ?? 0) : 0;
      out.push(encodeUmpMidi1ChannelVoice(group, status, data1, data2));
      i += 1 + len;
    } else {
      // System-/Real-Time-Bytes werden nicht nach MT2 konvertiert.
      i += 1;
    }
  }
  return out;
}
