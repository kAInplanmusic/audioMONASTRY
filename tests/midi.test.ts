import { describe, it, expect } from 'vitest';
import {
  cc, noteOn, noteOff, pitchBend, nrpn, sysex, isSysex, parseSysex,
  parseStatus, channelOf, split14, join14, NrpnParser,
} from '../src/utils/midi';

describe('MIDI-Utils: Basis-Kodierung', () => {
  it('cc() clamps und setzt das Status-Nibble', () => {
    expect(cc(1, 7, 100)).toEqual([0xb1, 7, 100]);
    expect(cc(0, 300, -5)).toEqual([0xb0, 127, 0]);
  });

  it('noteOn/noteOff', () => {
    expect(noteOn(9, 60, 127)).toEqual([0x99, 60, 127]);
    expect(noteOff(9, 60)).toEqual([0x89, 60, 0]);
  });

  it('pitchBend 14-Bit', () => {
    expect(pitchBend(0, 8192)).toEqual([0xe0, 0, 64]); // Mitte
    expect(pitchBend(0, 0)).toEqual([0xe0, 0, 0]);
    expect(pitchBend(0, 16383)).toEqual([0xe0, 127, 127]);
  });

  it('parseStatus + channelOf', () => {
    expect(parseStatus(0xb3)).toEqual({ kind: 'controlChange', channel: 3 });
    expect(parseStatus(0x90)).toEqual({ kind: 'noteOn', channel: 0 });
    expect(channelOf(0x95)).toBe(5);
  });

  it('split14/join14 roundtrip', () => {
    const { msb, lsb } = split14(0x2a3c);
    expect(join14(msb, lsb)).toBe(0x2a3c);
  });
});

describe('MIDI-Utils: NRPN', () => {
  it('nrpn() erzeugt die korrekte CC-Sequenz inkl. RPN-Null', () => {
    const seq = nrpn(2, 0x1234, 0x2a3c);
    expect(seq).toEqual([
      0xb2, 99, (0x1234 >> 7) & 0x7f, // 0x24
      0xb2, 98, 0x1234 & 0x7f,        // 0x34
      0xb2, 6, (0x2a3c >> 7) & 0x7f,  // 0x54
      0xb2, 38, 0x2a3c & 0x7f,        // 0x3c
      0xb2, 101, 0x7f,
      0xb2, 100, 0x7f,
    ]);
  });

  it('NrpnParser akkumuliert CCs und liefert den 14-Bit-Wert', () => {
    const p = new NrpnParser();
    const n = 0x1234;
    const v = 0x2a3c;
    expect(p.push(99, n >> 7)).toBeNull();
    expect(p.push(98, n & 0x7f)).toBeNull();
    expect(p.push(6, v >> 7)).toBeNull();
    expect(p.push(38, v & 0x7f)).toEqual({ nrpn: n, value: v });
    expect(p.push(6, 0)).toBeNull(); // MSB allein reicht nicht
    expect(p.push(38, 5)).toEqual({ nrpn: n, value: 5 });
  });
});

describe('MIDI-Utils: SysEx', () => {
  it('sysex() umschließt mit F0/F7 und maskiert 7-Bit', () => {
    expect(sysex([0x7d, 0x01, 0x80])).toEqual([0xf0, 0x7d, 0x01, 0x00, 0xf7]);
  });

  it('isSysex/parseSysex roundtrip', () => {
    const msg = sysex([0x7d, 0x42, 0x69]);
    expect(isSysex(msg)).toBe(true);
    expect(parseSysex(msg)).toEqual([0x7d, 0x42, 0x69]);
    expect(isSysex([0x90, 60, 100])).toBe(false);
    expect(parseSysex([0x90, 60, 100])).toEqual([]);
  });
});
