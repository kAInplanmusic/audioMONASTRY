/**
 * audioMONASTRY · MIDI-1.0-Codec (vollständig, plattformneutral)
 * ===============================================================
 * Ergänzt `src/utils/midi.ts` um die fehlenden MIDI-1.0-Teile:
 * Clock, Start/Stop/Continue, Song Position, SysEx-Streaming,
 * Poly-/Channel-Aftertouch, RPN und Running Status.
 *
 * Bewusst OHNE Browser-/Node-Abhängigkeiten: nutzbar in UI, Adaptern,
 * Sidecars und Tests. Keine Allokation im Hot-Path außerhalb der
 * Event-Objekte (Main-Thread-Parsing, nie im Audio-Callback).
 */

import type { ControlMessage } from '../interfaces';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export type ParsedMidiEvent =
  | { type: 'noteOn'; channel: number; note: number; velocity: number }
  | { type: 'noteOff'; channel: number; note: number; velocity: number }
  | { type: 'polyAftertouch'; channel: number; note: number; pressure: number }
  | { type: 'cc'; channel: number; controller: number; value: number }
  | { type: 'program'; channel: number; program: number }
  | { type: 'channelAftertouch'; channel: number; pressure: number }
  | { type: 'pitchBend'; channel: number; value: number }
  | { type: 'clock' }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'continue' }
  | { type: 'songPosition'; position: number }
  | { type: 'sysex'; data: number[] }
  | { type: 'rpn'; channel: number; parameter: number; value: number }
  | { type: 'nrpn'; channel: number; parameter: number; value: number };

export const MIDI_RT = {
  clock: 0xf8,
  start: 0xfa,
  continue: 0xfb,
  stop: 0xfc,
  activeSensing: 0xfe,
  reset: 0xff,
} as const;

export const MIDI_SYSTEM = {
  sysexStart: 0xf0,
  sysexEnd: 0xf7,
  songPosition: 0xf2,
} as const;

const clamp7 = (v: number): number => Math.max(0, Math.min(127, Math.round(v)));
const join14 = (msb: number, lsb: number): number => ((clamp7(msb) << 7) | clamp7(lsb)) & 0x3fff;

// ---------------------------------------------------------------------------
// Parameter-Number-Parser (RPN/NRPN, 14-Bit)
// ---------------------------------------------------------------------------

interface ParameterNumberResult {
  kind: 'rpn' | 'nrpn';
  parameter: number;
  value: number;
}

/**
 * Zustandsbehafteter Parser für RPN und NRPN.
 * CC 101/100 = RPN-Nummer, CC 99/98 = NRPN-Nummer, CC 6/38 = Datenwert.
 */
export class ParameterNumberParser {
  private mode: 'rpn' | 'nrpn' = 'rpn';
  private paramMsb = 0x7f;
  private paramLsb = 0x7f;
  private dataMsb = 0;
  private dataLsb = 0;
  private hasMsb = false;
  private hasLsb = false;

  /** Füttert einen CC; liefert ein Ergebnis oder null. */
  push(controller: number, value: number): ParameterNumberResult | null {
    switch (controller & 0x7f) {
      case 101: this.mode = 'rpn'; this.paramMsb = clamp7(value); return null;
      case 100: this.mode = 'rpn'; this.paramLsb = clamp7(value); return null;
      case 99: this.mode = 'nrpn'; this.paramMsb = clamp7(value); return null;
      case 98: this.mode = 'nrpn'; this.paramLsb = clamp7(value); return null;
      case 6: this.dataMsb = clamp7(value); this.hasMsb = true; break;
      case 38: this.dataLsb = clamp7(value); this.hasLsb = true; break;
      default: return null;
    }
    if (this.hasMsb && this.hasLsb) {
      const result: ParameterNumberResult = {
        kind: this.mode,
        parameter: join14(this.paramMsb, this.paramLsb),
        value: join14(this.dataMsb, this.dataLsb),
      };
      this.hasMsb = false;
      this.hasLsb = false;
      return result;
    }
    return null;
  }

  reset(): void {
    this.mode = 'rpn';
    this.paramMsb = 0x7f;
    this.paramLsb = 0x7f;
    this.dataMsb = 0;
    this.dataLsb = 0;
    this.hasMsb = false;
    this.hasLsb = false;
  }
}

/** RPN-Parser (Alias mit fester RPN-Semantik für externe Nutzer). */
export class RpnParser {
  private inner = new ParameterNumberParser();

  push(controller: number, value: number): { parameter: number; value: number } | null {
    const r = this.inner.push(controller, value);
    return r && r.kind === 'rpn' ? { parameter: r.parameter, value: r.value } : null;
  }

  reset(): void { this.inner.reset(); }
}

// ---------------------------------------------------------------------------
// Streaming-Parser (Running Status, SysEx, Real-Time)
// ---------------------------------------------------------------------------

const MAX_SYSEX_LENGTH = 64 * 1024; // Schutz vor unbegrenztem Speicherwachstum

/**
 * Byte-weiser MIDI-1.0-Streaming-Parser.
 *
 * - Running Status (Datenbytes nach Channel-Voice-Status)
 * - SysEx-Streaming (F0 … F7), Real-Time-Bytes dürfen SysEx unterbrechen
 * - RPN/NRPN-Auflösung über {@link ParameterNumberParser}
 */
export class MidiStreamParser {
  private runningStatus = 0;
  private pendingData: number[] = [];
  private pendingLen = 0;
  private sysexBuf: number[] = [];
  private inSysex = false;
  private pn = new ParameterNumberParser();

  /** Verarbeitet ein Byte-Array und liefert alle vollständigen Events. */
  push(data: ArrayLike<number>): ParsedMidiEvent[] {
    const out: ParsedMidiEvent[] = [];
    for (let i = 0; i < data.length; i++) this.pushByte(data[i] & 0xff, out);
    return out;
  }

  /** Verarbeitet ein einzelnes Byte (Event-Liste wird erweitert). */
  pushByte(byte: number, out: ParsedMidiEvent[] = []): ParsedMidiEvent[] {
    const b = byte & 0xff;

    // Real-Time-Bytes erscheinen überall und unterbrechen nichts.
    switch (b) {
      case MIDI_RT.clock: out.push({ type: 'clock' }); return out;
      case MIDI_RT.start: out.push({ type: 'start' }); return out;
      case MIDI_RT.continue: out.push({ type: 'continue' }); return out;
      case MIDI_RT.stop: out.push({ type: 'stop' }); return out;
      case MIDI_RT.activeSensing:
      case MIDI_RT.reset:
        return out;
      default: break;
    }

    // SysEx-Streaming: F0 eröffnet, F7 schließt. Status-Bytes außerhalb
    // Real-Time beenden SysEx implizit (fehlerhafte Geräte).
    if (this.inSysex) {
      if (b === MIDI_SYSTEM.sysexEnd) {
        out.push({ type: 'sysex', data: this.sysexBuf });
        this.sysexBuf = [];
        this.inSysex = false;
        return out;
      }
      if (b >= 0x80) {
        // Defektes SysEx ohne F7 – verwerfen und als Status behandeln.
        this.sysexBuf = [];
        this.inSysex = false;
      } else {
        if (this.sysexBuf.length < MAX_SYSEX_LENGTH) this.sysexBuf.push(b);
        return out;
      }
    }

    if (b === MIDI_SYSTEM.sysexStart) {
      this.inSysex = true;
      this.sysexBuf = [];
      return out;
    }

    if (b >= 0x80) {
      // System Common mit Datenbedarf: Song Position (F2).
      // (Real-Time und SysEx wurden oben bereits behandelt.)
      if (b === MIDI_SYSTEM.songPosition) {
        this.pendingData = [];
        this.pendingLen = 2;
        this.pendingSystem = 'songPosition';
        return out;
      }
      // Verbleibende Status-Bytes (System Common ohne Datenbedarf).
      if (b >= 0xf0) return out;

      const kind = b & 0xf0;
      const channel = (b & 0x0f) + 1;

      if (kind >= 0x80 && kind <= 0xe0) {
        this.runningStatus = b;
        this.pendingData = [];
        this.pendingLen = this.dataLengthFor(kind);
        if (this.pendingLen === 0) {
          this.emitChannelMessage(kind, channel, [], out);
        }
        return out;
      }
      return out;
    }

    // Datenbyte
    if (this.pendingLen > 0) {
      this.pendingData.push(b);
      if (this.pendingData.length >= this.pendingLen) {
        if (this.pendingSystem) {
          this.emitSystem(this.pendingSystem, this.pendingData, out);
          this.pendingSystem = null;
        } else {
          const kind = this.runningStatus & 0xf0;
          const channel = (this.runningStatus & 0x0f) + 1;
          this.emitChannelMessage(kind, channel, this.pendingData, out);
        }
        this.pendingData = [];
        this.pendingLen = 0;
      }
      return out;
    }

    // Running Status: Datenbyte ohne vorherigen Status.
    if (this.runningStatus !== 0) {
      const kind = this.runningStatus & 0xf0;
      const channel = (this.runningStatus & 0x0f) + 1;
      const len = this.dataLengthFor(kind);
      if (len > 0) {
        this.pendingData = [b];
        this.pendingLen = len;
        if (this.pendingData.length >= this.pendingLen) {
          this.emitChannelMessage(kind, channel, this.pendingData, out);
          this.pendingData = [];
          this.pendingLen = 0;
        }
      }
    }
    return out;
  }

  private pendingSystem: 'songPosition' | null = null;

  private dataLengthFor(kind: number): number {
    switch (kind) {
      case 0x80: case 0x90: case 0xa0: case 0xb0: case 0xe0: return 2;
      case 0xc0: case 0xd0: return 1;
      default: return 0;
    }
  }

  private emitChannelMessage(kind: number, channel: number, d: number[], out: ParsedMidiEvent[]): void {
    const c = clamp7(channel - 1) + 1;
    switch (kind) {
      case 0x80:
        out.push({ type: 'noteOff', channel: c, note: clamp7(d[0] ?? 0), velocity: clamp7(d[1] ?? 0) });
        break;
      case 0x90:
        out.push(
          (d[1] ?? 0) > 0
            ? { type: 'noteOn', channel: c, note: clamp7(d[0] ?? 0), velocity: clamp7(d[1] ?? 0) }
            : { type: 'noteOff', channel: c, note: clamp7(d[0] ?? 0), velocity: 0 },
        );
        break;
      case 0xa0:
        out.push({ type: 'polyAftertouch', channel: c, note: clamp7(d[0] ?? 0), pressure: clamp7(d[1] ?? 0) });
        break;
      case 0xb0: {
        out.push({ type: 'cc', channel: c, controller: clamp7(d[0] ?? 0), value: clamp7(d[1] ?? 0) });
        const pn = this.pn.push(d[0] ?? 0, d[1] ?? 0);
        if (pn) out.push({ type: pn.kind, channel: c, parameter: pn.parameter, value: pn.value });
        break;
      }
      case 0xc0:
        out.push({ type: 'program', channel: c, program: clamp7(d[0] ?? 0) });
        break;
      case 0xd0:
        out.push({ type: 'channelAftertouch', channel: c, pressure: clamp7(d[0] ?? 0) });
        break;
      case 0xe0:
        // Pitch Bend: LSB zuerst (d[0]=LSB, d[1]=MSB).
        out.push({ type: 'pitchBend', channel: c, value: join14(d[1] ?? 0, d[0] ?? 0) });
        break;
      default:
        break;
    }
  }

  private emitSystem(system: 'songPosition', d: number[], out: ParsedMidiEvent[]): void {
    if (system === 'songPosition') {
      // Song Position: LSB zuerst (d[0]=LSB, d[1]=MSB).
      out.push({ type: 'songPosition', position: join14(d[1] ?? 0, d[0] ?? 0) });
    }
  }

  reset(): void {
    this.runningStatus = 0;
    this.pendingData = [];
    this.pendingLen = 0;
    this.pendingSystem = null;
    this.sysexBuf = [];
    this.inSysex = false;
    this.pn.reset();
  }
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/** MIDI Clock. */
export const midiClock = (): number[] => [MIDI_RT.clock];
/** Transport Start. */
export const midiStart = (): number[] => [MIDI_RT.start];
/** Transport Continue. */
export const midiContinue = (): number[] => [MIDI_RT.continue];
/** Transport Stop. */
export const midiStop = (): number[] => [MIDI_RT.stop];

/** Song Position Pointer (14-Bit, in 16th-Notes ab Songbeginn). */
export function midiSongPosition(position14: number): number[] {
  const v = Math.max(0, Math.min(16383, Math.round(position14)));
  return [MIDI_SYSTEM.songPosition, v & 0x7f, (v >> 7) & 0x7f];
}

/** Poly Aftertouch (Key Pressure). */
export function midiPolyAftertouch(channel: number, note: number, pressure: number): number[] {
  return [0xa0 | (clamp7(channel - 1) & 0x0f), clamp7(note), clamp7(pressure)];
}

/** Channel Pressure (Aftertouch). */
export function midiChannelAftertouch(channel: number, pressure: number): number[] {
  return [0xd0 | (clamp7(channel - 1) & 0x0f), clamp7(pressure)];
}

/** RPN senden (14-Bit-Parameter + 14-Bit-Wert, inkl. RPN-Null). */
export function rpn(channel: number, parameter: number, value14: number): number[] {
  const ch = clamp7(channel - 1) & 0x0f;
  const pMsb = (Math.max(0, Math.min(16383, Math.round(parameter))) >> 7) & 0x7f;
  const pLsb = Math.max(0, Math.min(16383, Math.round(parameter))) & 0x7f;
  const v = Math.max(0, Math.min(16383, Math.round(value14)));
  return [
    0xb0 | ch, 101, pMsb,
    0xb0 | ch, 100, pLsb,
    0xb0 | ch, 6, (v >> 7) & 0x7f,
    0xb0 | ch, 38, v & 0x7f,
    0xb0 | ch, 101, 0x7f,
    0xb0 | ch, 100, 0x7f,
  ];
}

/** NRPN senden (14-Bit-Parameter + 14-Bit-Wert, inkl. RPN-Null). */
export function nrpn(channel: number, parameter: number, value14: number): number[] {
  const ch = clamp7(channel - 1) & 0x0f;
  const pMsb = (Math.max(0, Math.min(16383, Math.round(parameter))) >> 7) & 0x7f;
  const pLsb = Math.max(0, Math.min(16383, Math.round(parameter))) & 0x7f;
  const v = Math.max(0, Math.min(16383, Math.round(value14)));
  return [
    0xb0 | ch, 99, pMsb,
    0xb0 | ch, 98, pLsb,
    0xb0 | ch, 6, (v >> 7) & 0x7f,
    0xb0 | ch, 38, v & 0x7f,
    0xb0 | ch, 101, 0x7f,
    0xb0 | ch, 100, 0x7f,
  ];
}

// ---------------------------------------------------------------------------
// ControlMessage-Konvertierung (aus adapters.ts hierher verschoben – pur MIDI)
// ---------------------------------------------------------------------------

/** Wandelt ein vollständig geparstes MIDI-Event in ein ControlMessage. */
export function midiEventToControlMessage(ev: ParsedMidiEvent): ControlMessage {
  switch (ev.type) {
    case 'noteOn': return { kind: 'noteOn', idNum: ev.note, value: ev.velocity, channel: ev.channel };
    case 'noteOff': return { kind: 'noteOff', idNum: ev.note, value: ev.velocity, channel: ev.channel };
    case 'cc': return { kind: 'cc', idNum: ev.controller, value: ev.value, channel: ev.channel };
    case 'program': return { kind: 'program', idNum: ev.program, value: ev.program, channel: ev.channel };
    case 'pitchBend': return { kind: 'pitch', idNum: 0, value: ev.value, channel: ev.channel };
    case 'polyAftertouch': return { kind: 'polyAftertouch', idNum: ev.note, value: ev.pressure, channel: ev.channel };
    case 'channelAftertouch': return { kind: 'channelAftertouch', idNum: 0, value: ev.pressure, channel: ev.channel };
    case 'clock': return { kind: 'clock', idNum: 0, value: 0, channel: 0 };
    case 'start': return { kind: 'start', idNum: 0, value: 0, channel: 0 };
    case 'stop': return { kind: 'stop', idNum: 0, value: 0, channel: 0 };
    case 'continue': return { kind: 'continue', idNum: 0, value: 0, channel: 0 };
    case 'songPosition': return { kind: 'songPosition', idNum: 0, value: ev.position & 0x7f, channel: 0, position: ev.position };
    case 'sysex': return { kind: 'sysex', idNum: 0, value: 0, channel: 0, data: ev.data };
    case 'rpn': return { kind: 'rpn', idNum: ev.parameter, value: ev.value, channel: ev.channel };
    case 'nrpn': return { kind: 'nrpn', idNum: ev.parameter, value: ev.value, channel: ev.channel };
    default: return { kind: 'cc', idNum: 0, value: 0, channel: 0 };
  }
}

/** Kodiert ein ControlMessage als MIDI-Byte-Sequenz (Rückkanal). */
export function encodeControlMessage(msg: ControlMessage): number[] {
  const ch = Math.max(0, Math.min(15, Math.round(msg.channel - 1)));
  const v7 = Math.max(0, Math.min(127, Math.round(msg.value)));
  const id7 = Math.max(0, Math.min(127, Math.round(msg.idNum)));
  switch (msg.kind) {
    case 'noteOn': return [0x90 | ch, id7, v7 > 0 ? v7 : 1];
    case 'noteOff': return [0x80 | ch, id7, v7];
    case 'cc': return [0xb0 | ch, id7, v7];
    case 'program': return [0xc0 | ch, id7];
    case 'pitch': {
      const v = Math.max(0, Math.min(16383, Math.round(msg.value)));
      return [0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f];
    }
    case 'polyAftertouch': return [0xa0 | ch, id7, v7];
    case 'channelAftertouch': return [0xd0 | ch, v7];
    case 'clock': return midiClock();
    case 'start': return midiStart();
    case 'stop': return midiStop();
    case 'continue': return midiContinue();
    case 'songPosition': {
      const p = msg.position ?? msg.value;
      return midiSongPosition(p);
    }
    case 'rpn': return rpn(ch + 1, msg.idNum, msg.value);
    case 'nrpn': return nrpn(ch + 1, msg.idNum, msg.value);
    case 'sysex':
      return msg.data && msg.data.length > 0 ? [0xf0, ...msg.data.map((b) => b & 0x7f), 0xf7] : [];
    default: return [];
  }
}
