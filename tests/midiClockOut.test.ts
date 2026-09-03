import { describe, it, expect } from 'vitest';
import {
  MidiClockOut, PPQN, PULSES_PER_STEP, drumNoteFor, stepDurationMs,
} from '../src/core/hardware/midiClockOut';

/** Sammelt alle gesendeten Nachrichten mit Zeitstempel. */
function makeSink() {
  const sent: Array<{ data: number[]; t?: number }> = [];
  return {
    sent,
    sink: { send: (data: number[], t?: number) => { sent.push({ data, t }); } },
  };
}

function bytesOf(sent: Array<{ data: number[] }>): number[] {
  return sent.map((m) => m.data[0]);
}

describe('NEW-MONK-1 · MIDI-Out/Clock-Ausgabe', () => {
  it('nutzt 24 PPQN bzw. 6 Pulse pro 16th-Step', () => {
    expect(PPQN).toBe(24);
    expect(PULSES_PER_STEP).toBe(6);
  });

  it('sendet ohne Port und ohne Enable nichts', () => {
    const clock = new MidiClockOut();
    clock.start(0, 0);
    expect(clock.isRunning()).toBe(false);

    const { sent, sink } = makeSink();
    clock.setSink(sink);
    clock.start(0, 0); // noch nicht enabled
    expect(sent).toHaveLength(0);
  });

  it('startet mit Song Position + Start und stoppt mit Stop', () => {
    const { sent, sink } = makeSink();
    const clock = new MidiClockOut();
    clock.setSink(sink);
    clock.setEnabled(true);

    clock.start(0, 1000);
    expect(sent[0].data).toEqual([0xf2, 0, 0]); // Song Position 0
    expect(sent[1].data).toEqual([0xfa]);       // Start
    expect(clock.isRunning()).toBe(true);

    clock.stop(2000);
    expect(sent[sent.length - 1].data).toEqual([0xfc]); // Stop
    expect(clock.isRunning()).toBe(false);
  });

  it('nutzt Continue + Song Position beim Wiedereinstieg mitten im Pattern', () => {
    const { sent, sink } = makeSink();
    const clock = new MidiClockOut();
    clock.setSink(sink);
    clock.setEnabled(true);

    clock.start(9, 0);
    expect(sent[0].data).toEqual([0xf2, 9, 0]);
    expect(sent[1].data).toEqual([0xfb]); // Continue
  });

  it('plant 6 Clock-Pulse pro Step gleichmäßig über die Step-Dauer', () => {
    const { sent, sink } = makeSink();
    const clock = new MidiClockOut();
    clock.setSink(sink);
    clock.setEnabled(true);
    clock.start(0, 0);
    sent.length = 0;

    const pulses = clock.emitStep({ timestampMs: 1000, bpm: 120 });
    expect(pulses).toBe(6);

    const clocks = sent.filter((m) => m.data[0] === 0xf8);
    expect(clocks).toHaveLength(6);
    const stepMs = stepDurationMs(120); // 125 ms @ 120 BPM
    expect(stepMs).toBeCloseTo(125, 6);
    for (let i = 0; i < 6; i++) {
      expect(clocks[i].t).toBeCloseTo(1000 + (i * stepMs) / 6, 6);
    }
    expect(clock.getPulseCount()).toBe(6);
  });

  it('gibt Noten als Note-On + zeitversetztes Note-Off auf Kanal 10 aus', () => {
    const { sent, sink } = makeSink();
    const clock = new MidiClockOut({ noteLengthMs: 25 });
    clock.setSink(sink);
    clock.setEnabled(true);
    clock.start(0, 0);
    sent.length = 0;

    clock.emitStep({ notes: [{ note: 36, velocity: 1 }], timestampMs: 500, bpm: 128 });
    const noteOn = sent.find((m) => (m.data[0] & 0xf0) === 0x90)!;
    const noteOff = sent.find((m) => (m.data[0] & 0xf0) === 0x80)!;
    expect(noteOn.data).toEqual([0x99, 36, 127]); // Kanal 10 (Index 9)
    expect(noteOn.t).toBe(500);
    expect(noteOff.data).toEqual([0x89, 36, 0]);
    expect(noteOff.t).toBe(525);
  });

  it('sendet keine Steps, solange der Transport nicht läuft', () => {
    const { sent, sink } = makeSink();
    const clock = new MidiClockOut();
    clock.setSink(sink);
    clock.setEnabled(true);
    expect(clock.emitStep({ notes: [{ note: 36 }], timestampMs: 0 })).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('stoppt den externen Transport beim Deaktivieren und beim Portwechsel', () => {
    const a = makeSink();
    const clock = new MidiClockOut();
    clock.setSink(a.sink);
    clock.setEnabled(true);
    clock.start(0, 0);
    clock.setEnabled(false);
    expect(bytesOf(a.sent)).toContain(0xfc);
    expect(clock.isRunning()).toBe(false);

    clock.setEnabled(true);
    clock.start(0, 0);
    const b = makeSink();
    clock.setSink(b.sink);
    expect(bytesOf(a.sent).filter((s) => s === 0xfc)).toHaveLength(2);
    expect(clock.isRunning()).toBe(false);
  });

  it('überlebt Portfehler (Hotplug) ohne Exception', () => {
    const clock = new MidiClockOut();
    clock.setSink({ send: () => { throw new Error('port gone'); } });
    clock.setEnabled(true);
    expect(() => clock.start(0, 0)).not.toThrow();
    expect(() => clock.emitStep({ notes: [{ note: 38 }], timestampMs: 0 })).not.toThrow();
    expect(() => clock.stop(0)).not.toThrow();
  });

  it('mappt DrumKit-Sounds auf GM-Percussion-Noten', () => {
    expect(drumNoteFor('kick', 'kick')).toBe(36);
    expect(drumNoteFor('snare', 'snare')).toBe(38);
    expect(drumNoteFor('clap', 'clap')).toBe(39);
    expect(drumNoteFor('chh', 'hat')).toBe(42);
    expect(drumNoteFor('ohh', 'hat')).toBe(46);
    expect(drumNoteFor('ltom', 'tom')).toBe(45);
    expect(drumNoteFor('htom', 'tom')).toBe(50);
    // Unbekannte ID → Typ-Mapping, unbekannter Typ → Perc-Fallback.
    expect(drumNoteFor('unknown-sound', 'snare')).toBe(38);
    expect(drumNoteFor('unknown-sound', 'weird')).toBe(56);
  });

  it('clamped BPM und Notenwerte NaN-sicher', () => {
    expect(stepDurationMs(Number.NaN)).toBeCloseTo(60_000 / 128 / 4, 6);
    expect(stepDurationMs(1)).toBeCloseTo(60_000 / 20 / 4, 6);
    expect(stepDurationMs(9999)).toBeCloseTo(60_000 / 300 / 4, 6);

    const { sent, sink } = makeSink();
    const clock = new MidiClockOut();
    clock.setSink(sink);
    clock.setEnabled(true);
    clock.start(0, 0);
    sent.length = 0;
    clock.emitStep({ notes: [{ note: 999, velocity: 5 }, { note: Number.NaN, velocity: 0 }], timestampMs: 0 });
    const notes = sent.filter((m) => (m.data[0] & 0xf0) === 0x90);
    expect(notes[0].data).toEqual([0x99, 127, 127]);
    expect(notes[1].data).toEqual([0x99, 0, 1]);
  });

  it('all-notes-off sendet CC 123 und CC 120 auf dem Drum-Kanal', () => {
    const { sent, sink } = makeSink();
    const clock = new MidiClockOut();
    clock.setSink(sink);
    clock.allNotesOff(0);
    expect(sent.map((m) => m.data)).toEqual([[0xb9, 123, 0], [0xb9, 120, 0]]);
  });
});
