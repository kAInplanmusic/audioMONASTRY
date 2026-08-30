import { describe, expect, it } from 'vitest';
import {
  midiEventToControlMessage, encodeControlMessage,
} from '../src/core/hardware/midiCodec';
import { fieldsFromWebHidCollections } from '../src/core/adapters';

describe('midiEventToControlMessage', () => {
  it('mappt alle MIDI-1.0-Eventtypen', () => {
    expect(midiEventToControlMessage({ type: 'noteOn', channel: 1, note: 60, velocity: 100 }))
      .toEqual({ kind: 'noteOn', idNum: 60, value: 100, channel: 1 });
    expect(midiEventToControlMessage({ type: 'cc', channel: 2, controller: 7, value: 99 }))
      .toEqual({ kind: 'cc', idNum: 7, value: 99, channel: 2 });
    expect(midiEventToControlMessage({ type: 'pitchBend', channel: 3, value: 8192 }))
      .toEqual({ kind: 'pitch', idNum: 0, value: 8192, channel: 3 });
    expect(midiEventToControlMessage({ type: 'sysex', data: [0x7d, 0x01] }))
      .toEqual({ kind: 'sysex', idNum: 0, value: 0, channel: 0, data: [0x7d, 0x01] });
  });
});

describe('encodeControlMessage (MIDI-Rückkanal)', () => {
  it('kodiert CC, Note On/Off, Pitch Bend', () => {
    expect(encodeControlMessage({ kind: 'cc', idNum: 7, value: 100, channel: 1 })).toEqual([0xb0, 7, 100]);
    expect(encodeControlMessage({ kind: 'noteOn', idNum: 60, value: 100, channel: 1 })).toEqual([0x90, 60, 100]);
    expect(encodeControlMessage({ kind: 'noteOff', idNum: 60, value: 0, channel: 1 })).toEqual([0x80, 60, 0]);
    expect(encodeControlMessage({ kind: 'pitch', idNum: 0, value: 8192, channel: 1 })).toEqual([0xe0, 0, 64]);
  });

  it('kodiert Transport/SongPosition/SysEx', () => {
    expect(encodeControlMessage({ kind: 'clock', idNum: 0, value: 0, channel: 0 })).toEqual([0xf8]);
    expect(encodeControlMessage({ kind: 'songPosition', idNum: 0, value: 0, channel: 0, position: 0x1234 })).toEqual([0xf2, 0x34, 0x24]);
    expect(encodeControlMessage({ kind: 'sysex', idNum: 0, value: 0, channel: 0, data: [0x7d, 0x01] })).toEqual([0xf0, 0x7d, 0x01, 0xf7]);
  });
});

describe('fieldsFromWebHidCollections', () => {
  it('baut Feld-Definitionen aus WebHID-Collections (Buttons + Achse)', () => {
    const fields = fieldsFromWebHidCollections([
      {
        usagePage: 0x01,
        inputReports: [
          {
            reportId: 0,
            items: [
              { usagePage: 0x01, usages: [0x30], reportSize: 8, reportCount: 1, logicalMinimum: 0, logicalMaximum: 255, isAbsolute: true },
              { usagePage: 0x09, usageMinimum: 1, usageMaximum: 8, reportSize: 1, reportCount: 8, logicalMinimum: 0, logicalMaximum: 1, isAbsolute: true },
            ],
          },
        ],
      },
    ]);

    expect(fields.fields).toHaveLength(9);
    expect(fields.fields[0]).toMatchObject({ usagePage: 0x01, usage: 0x30, bitOffset: 0, bitSize: 8 });
    expect(fields.fields[1]).toMatchObject({ usagePage: 0x09, usage: 1, bitOffset: 8, bitSize: 1, isArray: true });
    expect(fields.usagePages).toEqual([0x01, 0x09]);
  });

  it('erkennt relative Felder (isAbsolute=false)', () => {
    const fields = fieldsFromWebHidCollections([
      {
        inputReports: [{ reportId: 1, items: [{ usagePage: 0x01, usages: [0x37], reportSize: 8, reportCount: 1, logicalMinimum: -127, logicalMaximum: 127, isAbsolute: false }] }],
      },
    ]);
    expect(fields.fields).toHaveLength(1);
    expect(fields.fields[0].isRelative).toBe(true);
    expect(fields.fields[0].reportId).toBe(1);
  });
});
