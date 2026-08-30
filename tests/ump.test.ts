import { describe, expect, it } from 'vitest';
import {
  encodeUmpMidi1ChannelVoice, parseUmpPacket, parseUmpMidi1ChannelVoice,
  umpMidi1ToBytes, midi1BytesToUmp, parseUmpMidi2,
  encodeUmpMidi2NoteOn, encodeUmpMidi2NoteOff, encodeUmpMidi2Controller,
  encodeUmpMidi2PitchBend, encodeUmpMidi2ChannelPressure, umpWordCount,
} from '../src/core/hardware/ump';

describe('UMP: Paket-Struktur', () => {
  it('ermittelt Wort-Anzahl je Message Type', () => {
    expect(umpWordCount(0x0)).toBe(1);
    expect(umpWordCount(0x2)).toBe(1);
    expect(umpWordCount(0x4)).toBe(2);
    expect(umpWordCount(0x5)).toBe(4);
    expect(umpWordCount(0xf)).toBe(0);
  });

  it('parst Message Type und Group', () => {
    const w = encodeUmpMidi1ChannelVoice(3, 0x90, 60, 100);
    const p = parseUmpPacket([w]);
    expect(p.messageType).toBe(0x2);
    expect(p.group).toBe(3);
    expect(p.words).toHaveLength(1);
  });
});

describe('UMP MT2: MIDI-1.0-Channel-Voice', () => {
  it('konvertiert MIDI-1.0-Bytes ↔ UMP verlustfrei', () => {
    const midi = [0x90, 60, 100, 0xb0, 7, 120];
    const words = midi1BytesToUmp(midi, 0);
    expect(words).toHaveLength(2);
    const back: number[] = [];
    for (const w of words) back.push(...umpMidi1ToBytes(parseUmpPacket([w])));
    expect(back).toEqual(midi);
  });

  it('kodiert Status/Data korrekt in Wort 0', () => {
    const w = encodeUmpMidi1ChannelVoice(0, 0x91, 0x40, 0x7f);
    const m = parseUmpMidi1ChannelVoice(parseUmpPacket([w]));
    expect(m.status).toBe(0x91);
    expect(m.data1).toBe(0x40);
    expect(m.data2).toBe(0x7f);
  });
});

describe('UMP MT4: MIDI-2.0-Channel-Voice', () => {
  it('rundet Note On mit 16-Bit-Velocity', () => {
    const words = encodeUmpMidi2NoteOn(2, 1, 60, 0x8000, 0, 0x1234);
    const p = parseUmpPacket(words);
    const m = parseUmpMidi2(p);
    expect(m.kind).toBe('midi2NoteOn');
    if (m.kind === 'midi2NoteOn') {
      expect(m.group).toBe(2);
      expect(m.channel).toBe(1);
      expect(m.note).toBe(60);
      expect(m.velocity16).toBe(0x8000);
      expect(m.attribute).toBe(0x1234);
    }
  });

  it('rundet Note Off', () => {
    const m = parseUmpMidi2(parseUmpPacket(encodeUmpMidi2NoteOff(0, 9, 40, 0)));
    expect(m.kind).toBe('midi2NoteOff');
    if (m.kind === 'midi2NoteOff') expect(m.channel).toBe(9);
  });

  it('kodiert/dekodiert Assignable Controller (32-Bit-Wert)', () => {
    const words = encodeUmpMidi2Controller(0, 3, 0x1, 0, 21, 0xffffffff);
    const m = parseUmpMidi2(parseUmpPacket(words));
    expect(m.kind).toBe('midi2Controller');
    if (m.kind === 'midi2Controller') {
      expect(m.status).toBe(0x1); // Assignable (NRPN)
      expect(m.index).toBe(21);
      expect(m.value32).toBe(0xffffffff);
    }
  });

  it('dekodiert Pitch Bend und Channel Pressure', () => {
    const pb = parseUmpMidi2(parseUmpPacket(encodeUmpMidi2PitchBend(0, 1, 0x80000000)));
    expect(pb).toEqual({ kind: 'midi2PitchBend', group: 0, channel: 1, value32: 0x80000000 });

    const cp = parseUmpMidi2(parseUmpPacket(encodeUmpMidi2ChannelPressure(0, 1, 0x12345678)));
    expect(cp).toEqual({ kind: 'midi2ChannelPressure', group: 0, channel: 1, value32: 0x12345678 });
  });

  it('lehnt unbekannte MT4-Status ab (ehrlich statt raten)', () => {
    const w0 = ((0x4 << 28) | (0xf << 20)) >>> 0;
    expect(() => parseUmpMidi2(parseUmpPacket([w0, 0]))).toThrow(/nicht dekodiert/);
  });
});
