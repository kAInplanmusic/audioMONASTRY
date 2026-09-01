import { describe, expect, it } from 'vitest';
import {
  MidiStreamParser, RpnParser, ParameterNumberParser,
  midiClock, midiStart, midiStop, midiContinue, midiSongPosition,
  midiPolyAftertouch, midiChannelAftertouch, rpn, nrpn,
  midiEventToControlMessage, encodeControlMessage,
} from '../src/core/hardware/midiCodec';

describe('MIDI-Streaming-Parser: Channel Voice', () => {
  it('parst Note On/Off inkl. Velocity-0-Konvention', () => {
    const p = new MidiStreamParser();
    const events = p.push([0x90, 60, 100, 0x80, 60, 0]);
    expect(events).toEqual([
      { type: 'noteOn', channel: 1, note: 60, velocity: 100 },
      { type: 'noteOff', channel: 1, note: 60, velocity: 0 },
    ]);
  });

  it('parst CC, Program Change, Pitch Bend und Aftertouch', () => {
    const p = new MidiStreamParser();
    const events = p.push([
      0xb0, 7, 100,        // CC 7
      0xc0, 42,            // Program Change
      0xe0, 0, 64,         // Pitch Bend Mitte
      0xa0, 60, 90,        // Poly Aftertouch
      0xd0, 80,            // Channel Pressure
    ]);
    expect(events).toEqual([
      { type: 'cc', channel: 1, controller: 7, value: 100 },
      { type: 'program', channel: 1, program: 42 },
      { type: 'pitchBend', channel: 1, value: 8192 },
      { type: 'polyAftertouch', channel: 1, note: 60, pressure: 90 },
      { type: 'channelAftertouch', channel: 1, pressure: 80 },
    ]);
  });

  it('beherrscht Running Status', () => {
    const p = new MidiStreamParser();
    const events = p.push([0x90, 60, 100, 62, 100, 64, 50]);
    expect(events.map((e) => (e.type === 'noteOn' ? e.note : null))).toEqual([60, 62, 64]);
  });
});

describe('MIDI-Streaming-Parser: System/Transport', () => {
  it('parst Clock, Start, Stop, Continue', () => {
    const p = new MidiStreamParser();
    const events = p.push([0xf8, 0xfa, 0xfb, 0xfc, 0xf8]);
    expect(events).toEqual([
      { type: 'clock' }, { type: 'start' }, { type: 'continue' }, { type: 'stop' }, { type: 'clock' },
    ]);
  });

  it('parst Song Position (14-Bit, LSB first)', () => {
    const p = new MidiStreamParser();
    const events = p.push([0xf2, 0x34, 0x24]);
    expect(events).toEqual([{ type: 'songPosition', position: 0x1234 }]);
  });

  it('parst SysEx mit Real-Time-Unterbrechung', () => {
    const p = new MidiStreamParser();
    const events = p.push([0xf0, 0x7d, 0x01, 0xf8, 0x02, 0xf7]);
    expect(events).toEqual([
      { type: 'clock' },
      { type: 'sysex', data: [0x7d, 0x01, 0x02] },
    ]);
  });
});

describe('MIDI-Streaming-Parser: RPN/NRPN', () => {
  it('löst NRPN aus CC-Sequenzen auf', () => {
    const p = new MidiStreamParser();
    const events = p.push(nrpn(1, 0x1234, 0x2a3c));
    const nrpnEvent = events.find((e) => e.type === 'nrpn');
    expect(nrpnEvent).toEqual({ type: 'nrpn', channel: 1, parameter: 0x1234, value: 0x2a3c });
  });

  it('löst RPN aus CC-Sequenzen auf', () => {
    const p = new MidiStreamParser();
    const events = p.push(rpn(2, 0x0000, 0x2000)); // Pitch-Bend-Sensitivity
    const rpnEvent = events.find((e) => e.type === 'rpn');
    expect(rpnEvent).toEqual({ type: 'rpn', channel: 2, parameter: 0, value: 0x2000 });
  });
});

describe('MIDI-Encoder', () => {
  it('erzeugt Clock/Transport-Bytes', () => {
    expect(midiClock()).toEqual([0xf8]);
    expect(midiStart()).toEqual([0xfa]);
    expect(midiStop()).toEqual([0xfc]);
    expect(midiContinue()).toEqual([0xfb]);
  });

  it('erzeugt Song Position korrekt (LSB first)', () => {
    expect(midiSongPosition(0x1234)).toEqual([0xf2, 0x34, 0x24]);
  });

  it('erzeugt Aftertouch-Bytes', () => {
    expect(midiPolyAftertouch(2, 64, 100)).toEqual([0xa1, 64, 100]);
    expect(midiChannelAftertouch(2, 99)).toEqual([0xd1, 99]);
  });

  it('RpnParser akkumuliert CCs', () => {
    const rp = new RpnParser();
    expect(rp.push(101, 0)).toBeNull();
    expect(rp.push(100, 0)).toBeNull();
    expect(rp.push(6, 0x40)).toBeNull();
    expect(rp.push(38, 0x00)).toEqual({ parameter: 0, value: 0x2000 });
  });

  it('ParameterNumberParser wechselt zwischen RPN und NRPN', () => {
    const pn = new ParameterNumberParser();
    pn.push(99, 0x24); pn.push(98, 0x34);
    pn.push(6, 1);
    const n = pn.push(38, 2); // Ergebnis kommt mit dem LSB (14-Bit vollständig)
    expect(n).toEqual({ kind: 'nrpn', parameter: 0x1234, value: 0x0082 });
    pn.push(101, 0); pn.push(100, 0);
    pn.push(6, 3);
    const r = pn.push(38, 4);
    expect(r).toEqual({ kind: 'rpn', parameter: 0, value: 0x0184 });
  });

  it('ControlMessage-Roundtrip ist verlustfrei (CC/Pitch/Program/RPN)', () => {
    const cc = midiEventToControlMessage({ type: 'cc', channel: 3, controller: 7, value: 100 });
    expect(encodeControlMessage(cc)).toEqual([0xb2, 7, 100]);
    const pitch = midiEventToControlMessage({ type: 'pitchBend', channel: 1, value: 0x1234 });
    expect(encodeControlMessage(pitch)).toEqual([0xe0, 0x34, 0x24]);
    const prog = midiEventToControlMessage({ type: 'program', channel: 1, program: 42 });
    expect(encodeControlMessage(prog)).toEqual([0xc0, 42]);
    const rpnMsg = midiEventToControlMessage({ type: 'rpn', channel: 1, parameter: 0, value: 0x2000 });
    expect(encodeControlMessage(rpnMsg)).toEqual(rpn(1, 0, 0x2000));
  });
});
