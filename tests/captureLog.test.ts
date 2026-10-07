// @vitest-environment node
/**
 * IDEA-2026-10-07-A · Capture: Eingabe-Ringpuffer + Quantisierung.
 */
import { describe, expect, it } from 'vitest';
import { EventCaptureLog, barSeconds, freqToMidi } from '../src/core/capture/eventCaptureLog';
import { captureGridOrigin, quantizeCapture } from '../src/core/capture/quantizeCapture';
import { buildCaptureResult, mergeCaptureBar } from '../src/core/capture/captureSession';
import { ALL_TRACKS, type TrackType } from '../src/types';

describe('EventCaptureLog · Ringpuffer', () => {
  it('überschreibt bei Überlauf das älteste Event und behält die Kapazität', () => {
    const log = new EventCaptureLog(4);
    for (let i = 0; i < 6; i++) log.record(i, 'trigger', 'channel1', -1, 1);
    expect(log.size).toBe(4);
    const times = log.snapshot(10, 120, 16).map((e) => e.time);
    expect(times).toEqual([2, 3, 4, 5]);
  });

  it('Standardkapazität 4096: nach 5000 Events bleiben die letzten 4096', () => {
    const log = new EventCaptureLog();
    for (let i = 0; i < 5000; i++) log.record(i * 0.001, 'trigger', 'channel2', -1, 0.5);
    expect(log.size).toBe(4096);
    const snap = log.snapshot(5, 120, 16);
    expect(snap.length).toBe(4096);
    expect(snap[0].time).toBeCloseTo(904 * 0.001, 9);
    expect(snap[snap.length - 1].time).toBeCloseTo(4999 * 0.001, 9);
  });

  it('liefert nur die letzten 16 Takte (120 BPM → 32 s) chronologisch', () => {
    const log = new EventCaptureLog(64);
    expect(barSeconds(120)).toBe(2);
    log.record(10, 'trigger', 'channel1', -1, 1); // 40 s vor jetzt → raus
    log.record(20, 'note-on', 'channel4', 60, 0.8); // genau 32 s vor jetzt → drin
    log.record(45, 'trigger', 'channel3', -1, 1);
    log.record(30, 'trigger', 'channel2', -1, 1); // außer der Reihe aufgezeichnet
    log.record(53, 'trigger', 'channel1', -1, 1); // nach jetzt → raus
    const snap = log.snapshot(52, 120);
    expect(snap.map((e) => e.time)).toEqual([20, 30, 45]);
    expect(snap[0]).toMatchObject({ kind: 'note-on', track: 'channel4', note: 60, velocity: 0.8 });
  });

  it('snapshot liefert Kopien (spätere Aufzeichnung verändert sie nicht)', () => {
    const log = new EventCaptureLog(1);
    log.record(1, 'trigger', 'channel1', -1, 1);
    const snap = log.snapshot(2, 120);
    log.record(1.5, 'note-on', 'channel8', 40, 0.3);
    expect(snap[0]).toMatchObject({ time: 1, track: 'channel1' });
  });

  it('klemmt Velocity auf 0..1 und rechnet Hz in MIDI um', () => {
    const log = new EventCaptureLog(2);
    log.recordNoteFreq(0, 'channel8', 440, 3);
    const [e] = log.snapshot(1, 120);
    expect(e).toMatchObject({ kind: 'note-on', note: 69, velocity: 1 });
    expect(freqToMidi(261.6256)).toBe(60);
    expect(freqToMidi(0)).toBe(-1);
  });
});

function ev(time: number, track: TrackType = 'channel1', kind: 'trigger' | 'note-on' = 'trigger', note = -1) {
  return { time, kind, track, note, velocity: 1 };
}

describe('quantizeCapture · Raster', () => {
  it('120 BPM, Transport-Start 0: Event bei 0,125 s → Step 1 (Index 1)', () => {
    const q = quantizeCapture([ev(0.125, 'channel3')], 120, { transportStartSec: 0 });
    expect(q.stepSec).toBeCloseTo(0.125, 12);
    expect(q.bars).toHaveLength(1);
    expect(q.bars[0].channel3.indexOf(true)).toBe(1);
    expect(q.suggestedBarIndex).toBe(0);
  });

  it('ohne Transport: Ursprung = erstes Event auf 16tel abgerundet', () => {
    expect(captureGridOrigin(10.06, 120, null)).toBeCloseTo(10, 9);
    const q = quantizeCapture([ev(0), ev(0.125, 'channel2'), ev(0.51, 'channel3')], 120);
    expect(q.bars[0].channel1[0]).toBe(true);
    expect(q.bars[0].channel2[1]).toBe(true);
    expect(q.bars[0].channel3[4]).toBe(true); // 0,51 s → round(4,08) = 4
  });

  it('BPM 90: 16tel = 1/6 s, Takt = 8/3 s, Events landen im richtigen Takt', () => {
    const step = 60 / 90 / 4;
    const bar = step * 16;
    const start = 5;
    const q = quantizeCapture([
      ev(start + 3 * step, 'channel1'),
      ev(start + bar + 7 * step + 0.02, 'channel5', 'note-on', 64), // leicht verspätet
      ev(start + 2 * bar + 15 * step - 0.03, 'channel8'), // leicht verfrüht
    ], 90, { transportStartSec: start });
    expect(q.stepSec).toBeCloseTo(1 / 6, 12);
    expect(q.bars).toHaveLength(3);
    expect(q.bars[0].channel1[3]).toBe(true);
    expect(q.bars[1].channel5[7]).toBe(true);
    expect(q.bars[2].channel8[15]).toBe(true);
    expect(q.notes).toEqual([{ bar: 1, step: 7, track: 'channel5', note: 64, velocity: 1 }]);
    expect(q.suggestedBarIndex).toBe(2);
  });

  it('Transport-Ausrichtung: Raster startet am Taktanfang vor dem ersten Event', () => {
    // 120 BPM, Takt 2 s; Transport ab 1 s; erstes Event bei 6,25 s → Taktanfang 5 s.
    expect(captureGridOrigin(6.25, 120, 1)).toBeCloseTo(5, 9);
    const q = quantizeCapture([ev(6.25)], 120, { transportStartSec: 1 });
    expect(q.bars[0].channel1[10]).toBe(true);
    // Transport-Start NACH dem ersten Event wird ignoriert (Regel 2).
    expect(captureGridOrigin(0.3, 120, 2)).toBeCloseTo(0.25, 9);
  });

  it('mehr als maxBars Takte: nur die letzten bleiben; leere Eingabe → kein Vorschlag', () => {
    const q = quantizeCapture([ev(0), ev(2 * 20)], 120, { transportStartSec: 0, maxBars: 16 });
    expect(q.bars).toHaveLength(16);
    expect(q.bars[15].channel1[0]).toBe(true);
    expect(q.suggestedBarIndex).toBe(15);
    expect(quantizeCapture([], 120).suggestedBarIndex).toBe(-1);
  });

  it('Vorschlag = letzter Takt mit Treffer (Takte 1–3 belegt → Index 2)', () => {
    const q = quantizeCapture([ev(0), ev(2.5), ev(4.0 + 0.01, 'channel2')], 120, { transportStartSec: 0 });
    expect(q.suggestedBarIndex).toBe(2);
  });
});

describe('Capture-Ergebnis + Sequencer-Merge', () => {
  it('buildCaptureResult ohne Abgriff meldet den Grund und liefert trotzdem das Pattern', () => {
    const log = new EventCaptureLog(16);
    log.record(1, 'trigger', 'channel1', -1, 1);
    const r = buildCaptureResult({ log, handle: null, supported: false, nowSec: 2, bpm: 120, transportStartSec: 0 });
    expect(r.audio).toBeNull();
    expect(r.audioUnavailable).toBe('unsupported');
    expect(r.suggestedBarIndex).toBe(0);
    expect(r.bars[0].channel1[8]).toBe(true);
  });

  it('mergeCaptureBar ergänzt (ODER) und behält die Pattern-Länge', () => {
    const current = Object.fromEntries(ALL_TRACKS.map((t) => [t, new Array(32).fill(false)])) as Record<TrackType, boolean[]>;
    current.channel1[0] = true;
    const bar = Object.fromEntries(ALL_TRACKS.map((t) => [t, new Array(16).fill(false)])) as Record<TrackType, boolean[]>;
    bar.channel1[4] = true;
    const merged = mergeCaptureBar(current, bar);
    expect(merged.channel1).toHaveLength(32);
    expect(merged.channel1[0]).toBe(true);
    expect(merged.channel1[4]).toBe(true);
    expect(current.channel1[4]).toBe(false); // Eingabe unverändert
  });
});
