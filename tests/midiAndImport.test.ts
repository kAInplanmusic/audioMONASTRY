import { describe, expect, it } from 'vitest';
import {
  DIGITAKT_CC,
  ccForTrack,
  ccMessage,
  midiClockStart,
  patternStepMessage,
  patternToMidi,
} from '../src/core/midi/digitakt2';
import { buildQuickImportEntries, dedupeEntries, inferTags, parseFileName } from '../src/core/library/quickImport';

describe('Digitakt 2 (AUDIO-MIDI)', () => {
  it('liefert CC-Map und Track-CCs', () => {
    expect(DIGITAKT_CC.level).toBe(7);
    expect(ccForTrack(DIGITAKT_CC.trig, 0)).toBe(36);
    expect(ccForTrack(DIGITAKT_CC.trig, 7, true)).toBe(51);
    expect(ccForTrack(DIGITAKT_CC.level, 4)).toBe(7); // nicht-Trig-CC bleibt
  });

  it('erzeugt Note-On/Off Step-Messages mit Track-Kanal', () => {
    const on = patternStepMessage({ track: 0, step: 0, on: true, velocity: 100 });
    expect(on).toEqual([0x90, 60, 100]);
    const off = patternStepMessage({ track: 1, step: 3, on: false });
    expect(off[0]).toBe(0x81);
  });

  it('konvertiert Pattern zu MIDI-Bytes und CC-Nachrichten', () => {
    const msgs = patternToMidi([
      { track: 2, step: 0, on: true },
      { track: 0, step: 4, on: true },
    ]);
    expect(msgs.length).toBe(2);
    expect(msgs[0][0]).toBe(0x90); // Track 0 zuerst (sortiert)
    expect(ccMessage(3, 10, 64)).toEqual([0xb3, 10, 64]);
    expect(midiClockStart()).toEqual([0xfa]);
  });
});

describe('biblioMONK Quick-Import (USB)', () => {
  it('parst "Interpret – Titel.wav"', () => {
    expect(parseFileName('Len Faki - Kraft und Licht (Ostgut Ton).wav'))
      .toMatchObject({ artist: 'Len Faki', title: 'Kraft und Licht (Ostgut Ton)' });
  });

  it('taggt Genre anhand Dateiname', () => {
    const tags = inferTags('Acid Bass 303 loop.wav');
    expect(tags).toContain('techno');
    expect(tags).toContain('bass');
    expect(tags).toContain('loop');
  });

  it('baut Einträge und erkennt Duplikate', () => {
    const entries = buildQuickImportEntries([
      { name: 'Kick 01.wav', size: 1000 },
      { name: 'Kick 01.wav', size: 1000 },
      { name: 'Orchester Streicher.wav', size: 5000 },
    ]);
    expect(entries.length).toBe(3);
    expect(dedupeEntries(entries).length).toBe(2);
    expect(entries[2].tags).toContain('orchestral');
  });
});
